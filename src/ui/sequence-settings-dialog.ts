import { BooleanInput, Button, Container, Element, Label, SelectInput, VectorInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { SequenceSettings } from '../render';
import { localize } from './localization';
import sceneExport from './svg/export.svg';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

class SequenceSettingsDialog extends Container {
    show: () => Promise<SequenceSettings | null>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'sequence-settings-dialog',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({
            id: 'dialog'
        });

        // header

        const headerIcon = createSvg(sceneExport, { id: 'icon' });
        const headerText = new Label({ id: 'text', text: localize('popup.render-sequence.header').toUpperCase() });
        const header = new Container({ id: 'header' });
        header.append(headerIcon);
        header.append(headerText);

        // resolution

        const resolutionLabel = new Label({ class: 'label', text: localize('popup.render-sequence.resolution') });
        const resolutionSelect = new SelectInput({
            class: 'select',
            defaultValue: '1080',
            options: [
                { v: '540', t: '960x540' },
                { v: '720', t: '1280x720' },
                { v: '1080', t: '1920x1080' },
                { v: '1440', t: '2560x1440' },
                { v: '4k', t: '3840x2160' }
            ]
        });
        const resolutionRow = new Container({ class: 'row' });
        resolutionRow.append(resolutionLabel);
        resolutionRow.append(resolutionSelect);

        // format

        const formatLabel = new Label({ class: 'label', text: localize('popup.render-sequence.format') });
        const formatSelect = new SelectInput({
            class: 'select',
            defaultValue: 'jpeg',
            options: [
                { v: 'jpeg', t: 'JPEG (Faster)' },
                { v: 'png', t: 'PNG (Lossless)' }
            ]
        });
        const formatRow = new Container({ class: 'row' });
        formatRow.append(formatLabel);
        formatRow.append(formatSelect);

        // frame range

        const totalFrames = events.invoke('timeline.frames');
        const frameRangeLabel = new Label({ class: 'label', text: localize('popup.render-sequence.frame-range') });
        const frameRangeInput = new VectorInput({
            class: 'vector-input',
            dimensions: 2,
            min: 0,
            max: totalFrames - 1,
            placeholder: [localize('popup.render-sequence.frame-range-first'), localize('popup.render-sequence.frame-range-last')],
            precision: 0,
            value: [0, totalFrames - 1]
        });
        const frameRangeRow = new Container({ class: 'row' });
        frameRangeRow.append(frameRangeLabel);
        frameRangeRow.append(frameRangeInput);

        // Validate frame range
        frameRangeInput.on('change', (value: number[]) => {
            if (value[0] > value[1]) {
                frameRangeInput.value = [value[1], value[0]];
            }
        });

        // portrait mode

        const portraitLabel = new Label({ class: 'label', text: localize('popup.render-sequence.portrait') });
        const portraitBoolean = new BooleanInput({ class: 'boolean', value: false });
        const portraitRow = new Container({ class: 'row' });
        portraitRow.append(portraitLabel);
        portraitRow.append(portraitBoolean);

        // transparent background

        const transparentBgLabel = new Label({ class: 'label', text: localize('popup.render-sequence.transparent-bg') });
        const transparentBgBoolean = new BooleanInput({ class: 'boolean', value: false });
        const transparentBgRow = new Container({ class: 'row' });
        transparentBgRow.append(transparentBgLabel);
        transparentBgRow.append(transparentBgBoolean);

        // show debug overlays

        const showDebugLabel = new Label({ class: 'label', text: localize('popup.render-sequence.show-debug') });
        const showDebugBoolean = new BooleanInput({ class: 'boolean', value: false });
        const showDebugRow = new Container({ class: 'row' });
        showDebugRow.append(showDebugLabel);
        showDebugRow.append(showDebugBoolean);

        // content

        const content = new Container({ id: 'content' });
        content.append(resolutionRow);
        content.append(formatRow);
        content.append(frameRangeRow);
        content.append(portraitRow);
        content.append(transparentBgRow);
        content.append(showDebugRow);

        // footer

        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button',
            text: localize('panel.render.cancel')
        });

        const okButton = new Button({
            class: 'button',
            text: localize('panel.render.ok')
        });

        footer.append(cancelButton);
        footer.append(okButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        // handle key bindings for enter and escape

        let onCancel: () => void;
        let onOK: () => void;

        cancelButton.on('click', () => onCancel());
        okButton.on('click', () => onOK());

        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
            }
        };

        // reset UI and configure for current state
        const reset = () => {
            const totalFrames = events.invoke('timeline.frames');
            frameRangeInput.max = totalFrames - 1;
            frameRangeInput.value = [0, totalFrames - 1];
        };

        // function implementations

        this.show = () => {
            reset();

            this.hidden = false;
            document.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<SequenceSettings | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onOK = () => {
                    const widths: Record<string, number> = {
                        '540': 960,
                        '720': 1280,
                        '1080': 1920,
                        '1440': 2560,
                        '4k': 3840
                    };

                    const heights: Record<string, number> = {
                        '540': 540,
                        '720': 720,
                        '1080': 1080,
                        '1440': 1440,
                        '4k': 2160
                    };

                    const portrait = portraitBoolean.value;
                    const width = (portrait ? heights : widths)[resolutionSelect.value];
                    const height = (portrait ? widths : heights)[resolutionSelect.value];

                    const frameRange = frameRangeInput.value as number[];

                    const sequenceSettings = {
                        startFrame: frameRange[0],
                        endFrame: frameRange[1],
                        width,
                        height,
                        transparentBg: transparentBgBoolean.value,
                        showDebug: showDebugBoolean.value,
                        format: formatSelect.value as 'png' | 'jpeg',
                        jpegQuality: 0.92
                    };

                    resolve(sequenceSettings);
                };
            }).finally(() => {
                document.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { SequenceSettingsDialog };

