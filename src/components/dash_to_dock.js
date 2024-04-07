import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const Signals = imports.signals;

import { PaintSignals } from '../effects/paint_signals.js';

import { Pipeline } from '../conveniences/pipeline.js';
import { DummyPipeline } from '../conveniences/dummy_pipeline.js';

const DASH_STYLES = [
    "transparent-dash",
    "light-dash",
    "dark-dash"
];


/// This type of object is created for every dash found, and talks to the main
/// DashBlur thanks to signals.
///
/// This allows to dynamically track the created dashes for each screen.
class DashInfos {
    constructor(
        dash_blur, dash, dash_container, dash_background,
        background, background_group, bg_manager
    ) {
        // the parent DashBlur object, to communicate
        this.dash_blur = dash_blur;
        this.dash = dash;
        this.dash_container = dash_container;
        this.dash_background = dash_background;
        this.background = background;
        this.background_group = background_group;
        this.bg_manager = bg_manager;
        this.settings = dash_blur.settings;
        this.old_style = this.dash._background.style;

        dash_blur.connections.connect(dash_blur, 'remove-dashes', () => {
            this.remove_style();
            this.destroy_dash();
        });
        dash_blur.connections.connect(dash_blur, 'override-style', () => this.override_style());
        dash_blur.connections.connect(dash_blur, 'remove-style', () => this.remove_style());
        dash_blur.connections.connect(dash_blur, 'show', () => this.background_group.show());
        dash_blur.connections.connect(dash_blur, 'hide', () => this.background_group.hide());
        dash_blur.connections.connect(dash_blur, 'update-size', () => this.update_size());
        dash_blur.connections.connect(dash_blur, 'change-blur-type', () => this.change_blur_type());
    }

    override_style() {
        this.remove_style();

        this.dash.set_style_class_name(
            DASH_STYLES[this.settings.dash_to_dock.STYLE_DASH_TO_DOCK]
        );
    }

    remove_style() {
        this.dash._background.style = this.old_style;

        DASH_STYLES.forEach(
            style => this.dash.remove_style_class_name(style)
        );
    }

    destroy_dash() {
        this.paint_signals?.disconnect_all();
        this.dash.get_parent().remove_child(this.background_group);
        this.bg_manager._bms_pipeline.destroy();
        this.bg_manager.destroy();
        this.background_group.destroy_all_children();
        this.background_group.destroy();
    }

    change_blur_type() {
        this.destroy_dash();

        let [
            background, background_group, bg_manager, paint_signals
        ] = this.dash_blur.add_blur(this.dash);

        this.background = background;
        this.background_group = background_group;
        this.bg_manager = bg_manager;
        this.paint_signals = paint_signals;

        this.dash.get_parent().insert_child_at_index(this.background_group, 0);

        this.update_size();
    }

    update_size() {
        if (this.dash_blur.is_static) {
            let [x, y] = this.get_dash_position(this.dash_container, this.dash_background);

            this.background.x = -x;
            this.background.y = -y;

            if (this.dash_container.get_style_class_name().includes("top"))
                this.background.set_clip(
                    x,
                    y + this.dash.y + this.dash_background.y,
                    this.dash_background.width,
                    this.dash_background.height
                );
            else if (this.dash_container.get_style_class_name().includes("bottom"))
                this.background.set_clip(
                    x,
                    y + this.dash.y + this.dash_background.y,
                    this.dash_background.width,
                    this.dash_background.height
                );
            else if (this.dash_container.get_style_class_name().includes("left"))
                this.background.set_clip(
                    x + this.dash.x + this.dash_background.x,
                    y + this.dash.y + this.dash_background.y,
                    this.dash_background.width,
                    this.dash_background.height
                );
            else if (this.dash_container.get_style_class_name().includes("right"))
                this.background.set_clip(
                    x + this.dash.x + this.dash_background.x,
                    y + this.dash.y + this.dash_background.y,
                    this.dash_background.width,
                    this.dash_background.height
                );
        } else {
            this.background.width = this.dash_background.width;
            this.background.height = this.dash_background.height;

            this.background.x = this.dash_background.x;
            this.background.y = this.dash_background.y + this.dash.y;
        }
    }

    get_dash_position(dash_container, dash_background) {
        var x, y;

        let monitor = Main.layoutManager.findMonitorForActor(dash_container);
        let dash_box = dash_container._slider.get_child();

        if (dash_container.get_style_class_name().includes("top")) {
            x = (monitor.width - dash_background.width) / 2;
            y = dash_box.y;
        } else if (dash_container.get_style_class_name().includes("bottom")) {
            x = (monitor.width - dash_background.width) / 2;
            y = monitor.height - dash_container.height;
        } else if (dash_container.get_style_class_name().includes("left")) {
            x = dash_box.x;
            y = dash_container.y + (dash_container.height - dash_background.height) / 2 - dash_background.y;
        } else if (dash_container.get_style_class_name().includes("right")) {
            x = monitor.width - dash_container.width;
            y = dash_container.y + (dash_container.height - dash_background.height) / 2 - dash_background.y;
        }

        return [x, y];
    }

    _log(str) {
        if (this.settings.DEBUG)
            console.log(`[Blur my Shell > dash]         ${str}`);
    }

    _warn(str) {
        console.warn(`[Blur my Shell > dash] ${str}`);
    }
}

export const DashBlur = class DashBlur {
    constructor(connections, settings, _) {
        this.dashes = [];
        this.connections = connections;
        this.settings = settings;
        this.paint_signals = new PaintSignals(connections);
        this.is_static = this.settings.dash_to_dock.STATIC_BLUR;
        this.enabled = false;
    }

    enable() {
        this.connections.connect(Main.uiGroup, 'child-added', (_, actor) => {
            if (
                (actor.get_name() === "dashtodockContainer") &&
                (actor.constructor.name === 'DashToDock')
            )
                this.try_blur(actor);
        });

        this.blur_existing_dashes();
        this.connect_to_overview();

        this.update_size();

        this.enabled = true;
    }

    // Finds all existing dashes on every monitor, and call `try_blur` on them
    // We cannot only blur `Main.overview.dash`, as there could be several
    blur_existing_dashes() {
        this._log("searching for dash");

        // blur every dash found, filtered by name
        Main.uiGroup.get_children().filter((child) => {
            return (child.get_name() === "dashtodockContainer") &&
                (child.constructor.name === 'DashToDock');
        }).forEach(dash_container => this.try_blur(dash_container));
    }

    // Tries to blur the dash contained in the given actor
    try_blur(dash_container) {
        let dash_box = dash_container._slider.get_child();

        // verify that we did not already blur that dash
        if (!dash_box.get_children().some(child =>
            child.get_name() === "bms-dash-backgroundgroup"
        )) {
            this._log("dash to dock found, blurring it");

            // finally blur the dash
            let dash = dash_box.get_children().find(child => {
                return child.get_name() === 'dash';
            });

            this.dashes.push(this.blur_dash_from(dash, dash_container));
        }
    }

    // Blurs the dash and returns a `DashInfos` containing its information
    blur_dash_from(dash, dash_container) {
        let [background, background_group, bg_manager, paint_signals] = this.add_blur(dash);

        // insert the background group to the right element
        dash.get_parent().insert_child_at_index(background_group, 0);

        // updates size and position on change
        this.connections.connect(
            dash,
            ['notify::width', 'notify::height'],
            _ => this.update_size()
        );
        this.connections.connect(
            dash_container,
            ['notify::width', 'notify::height', 'notify::y', 'notify::x'],
            _ => this.update_size()
        );

        const dash_background = dash.get_children().find(child => {
            return child.get_style_class_name() === 'dash-background';
        });

        // create infos
        let infos = new DashInfos(
            this,
            dash,
            dash_container,
            dash_background,
            background,
            background_group,
            bg_manager,
            paint_signals
        );

        this.update_size();
        this.update_background();

        // returns infos
        return infos;
    }

    add_blur(dash) {
        const monitor = Main.layoutManager.findMonitorForActor(dash);
        if (!monitor)
            return;

        const background_group = new Meta.BackgroundGroup({
            name: 'bms-dash-backgroundgroup', width: 0, height: 0
        });

        let background, bg_manager, paint_signals;
        let static_blur = this.settings.dash_to_dock.STATIC_BLUR;
        if (static_blur) {
            let bg_manager_list = [];
            const pipeline = new Pipeline(
                global.blur_my_shell._effects_manager,
                global.blur_my_shell._pipelines_manager,
                this.settings.dash_to_dock.PIPELINE
            );
            background = pipeline.create_background_with_effects(
                monitor.index, bg_manager_list,
                background_group, 'bms-dash-blurred-widget'
            );
            bg_manager = bg_manager_list[0];
        }
        else {
            let bg_manager_list = [];
            const pipeline = new DummyPipeline(
                global.blur_my_shell._effects_manager,
                this.settings.dash_to_dock
            );
            background = pipeline.create_background_with_effect(
                bg_manager_list, background_group, 'bms-dash-blurred-widget'
            );
            bg_manager = bg_manager_list[0];

            paint_signals = new PaintSignals(this.connections);

            // HACK
            //
            //`Shell.BlurEffect` does not repaint when shadows are under it. [1]
            //
            // This does not entirely fix this bug (shadows caused by windows
            // still cause artifacts), but it prevents the shadows of the dash
            // buttons to cause artifacts on the dash itself
            //
            // [1]: https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/2857

            if (this.settings.HACKS_LEVEL === 1) {
                this._log("dash hack level 1");
                paint_signals.disconnect_all();

                let rp = () => pipeline.repaint_effect();

                dash._box.get_children().forEach(icon => {
                    try {
                        let zone = icon.get_child_at_index(0);

                        if (zone)
                            this.connections.connect(zone, [
                                'enter-event', 'leave-event', 'button-press-event'
                            ], rp);
                    } catch (e) {
                        this._warn(`${e}, continuing`);
                    }
                });

                this.connections.connect(dash._box, 'child-added', (_, child) => {
                    try {
                        let zone = child.get_child_at_index(0);

                        if (zone)
                            this.connections.connect(zone, [
                                'enter-event', 'leave-event', 'button-press-event'
                            ], rp);
                    } catch (e) {
                        this._warn(`${e}, continuing`);
                    }
                });

                let show_apps = dash._showAppsIcon;

                this.connections.connect(show_apps, [
                    'enter-event', 'leave-event', 'button-press-event'
                ], rp);

                this.connections.connect(dash, 'leave-event', rp);
            } else if (this.settings.HACKS_LEVEL === 2) {
                this._log("dash hack level 2");

                paint_signals.connect(background, pipeline.effect);
            } else {
                paint_signals.disconnect_all();
            }
        }

        return [background, background_group, bg_manager, paint_signals];
    }

    change_blur_type() {
        this.is_static = this.settings.dash_to_dock.STATIC_BLUR;
        this.emit('change-blur-type', true);

        this.update_background();
    }

    /// Connect when overview if opened/closed to hide/show the blur accordingly
    connect_to_overview() {
        this.connections.disconnect_all_for(Main.overview);

        if (this.settings.dash_to_dock.UNBLUR_IN_OVERVIEW) {
            this.connections.connect(
                Main.overview, 'showing', _ => this.hide()
            );
            this.connections.connect(
                Main.overview, 'hidden', _ => this.show()
            );
        }
    };

    /// Updates the background to either remove it or not, according to the
    /// user preferences.
    update_background() {
        this._log("updating background");
        if (this.settings.dash_to_dock.OVERRIDE_BACKGROUND)
            this.emit('override-style', true);
        else
            this.emit('remove-style', true);
    }

    update_size() {
        this.emit('update-size', true);
    }

    show() {
        this.emit('show', true);
    }
    hide() {
        this.emit('hide', true);
    }

    set_sigma(s) { }
    set_brightness(b) { }
    set_corner_radius(r) { }
    set_color(c) { }
    set_noise_amount(n) { }
    set_noise_lightness(l) { }

    disable() {
        this._log("removing blur from dashes");

        this.emit('remove-dashes', true);

        this.dashes = [];
        this.connections.disconnect_all();

        this.enabled = false;
    }

    _log(str) {
        if (this.settings.DEBUG)
            console.log(`[Blur my Shell > dash manager] ${str}`);
    }

    _warn(str) {
        console.warn(`[Blur my Shell > dash manager] ${str}`);
    }
};

Signals.addSignalMethods(DashBlur.prototype);