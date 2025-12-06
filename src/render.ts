import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { path, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { PngCompressor } from './png-compressor';
import { Scene } from './scene';
import { Splat } from './splat';
import { localize } from './ui/localization';

type ImageSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
};

type VideoSettings = {
    startFrame: number;
    endFrame: number;
    frameRate: number;
    width: number;
    height: number;
    bitrate: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'mp4' | 'webm' | 'mov' | 'mkv';
    codec: 'h264' | 'h265' | 'vp9' | 'av1';
};

type SequenceSettings = {
    startFrame: number;
    endFrame: number;
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'png' | 'jpeg';
    jpegQuality?: number;
    motionBlurSamples?: number;
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

const downloadFile = (arrayBuffer: ArrayBuffer, filename: string) => {
    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};

const registerRenderEvents = (scene: Scene, events: Events) => {
    let compressor: PngCompressor;

    // wait for postrender to fire
    const postRender = () => {
        return new Promise<boolean>((resolve, reject) => {
            const handle = scene.events.on('postrender', () => {
                handle.off();
                try {
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
        });
    };

    events.function('render.offscreen', async (width: number, height: number): Promise<Uint8Array> => {
        try {
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { renderTarget } = scene.camera.entity.camera;
            const { workRenderTarget } = scene.camera;

            scene.dataProcessor.copyRt(renderTarget, workRenderTarget);

            // read the rendered frame
            await workRenderTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workRenderTarget, data });

            // flip y positions to have 0,0 at the top
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }

            return data;
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.entity.camera.clearColor.set(0, 0, 0, 0);
        }
    });

    events.function('render.image', async (imageSettings: ImageSettings) => {
        events.fire('startSpinner');

        try {
            const { width, height, transparentBg, showDebug } = imageSettings;
            const bgClr = events.invoke('bgClr');

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.entity.camera.clearColor.copy(bgClr);
            }

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { renderTarget } = scene.camera.entity.camera;
            const { workRenderTarget } = scene.camera;

            scene.dataProcessor.copyRt(renderTarget, workRenderTarget);

            // read the rendered frame
            await workRenderTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workRenderTarget, data });

            // the render buffer contains premultiplied alpha. so apply background color.
            if (!transparentBg) {
                // @ts-ignore
                const pixels = new Uint8ClampedArray(data.buffer);

                const { r, g, b } = bgClr;
                for (let i = 0; i < pixels.length; i += 4) {
                    const a = 255 - pixels[i + 3];
                    pixels[i + 0] += r * a;
                    pixels[i + 1] += g * a;
                    pixels[i + 2] += b * a;
                    pixels[i + 3] = 255;
                }
            }

            // construct the png compressor
            if (!compressor) {
                compressor = new PngCompressor();
            }

            const arrayBuffer = await compressor.compress(
                new Uint32Array(data.buffer),
                width,
                height
            );

            // construct filename
            const selected = events.invoke('selection') as Splat;
            const filename = `${removeExtension(selected?.name ?? 'SuperSplat')}-image.png`;

            // download
            downloadFile(arrayBuffer, filename);

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('render.failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.entity.camera.clearColor.set(0, 0, 0, 0);

            events.fire('stopSpinner');
        }
    });

    events.function('render.video', async (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream) => {
        events.fire('progressStart', localize('panel.render.render-video'));

        try {
            const { startFrame, endFrame, frameRate, width, height, bitrate, transparentBg, showDebug, format, codec: codecChoice } = videoSettings;

            const target = fileStream ? new StreamTarget(fileStream) : new BufferTarget();

            // Configure output format based on container selection
            let outputFormat: Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat;
            let fileExtension: string;

            if (format === 'webm') {
                outputFormat = new WebMOutputFormat();
                fileExtension = 'webm';
            } else if (format === 'mov') {
                outputFormat = new MovOutputFormat({
                    fastStart: 'in-memory'
                });
                fileExtension = 'mov';
            } else if (format === 'mkv') {
                outputFormat = new MkvOutputFormat();
                fileExtension = 'mkv';
            } else {
                outputFormat = new Mp4OutputFormat({
                    fastStart: 'in-memory'
                });
                fileExtension = 'mp4';
            }

            // Configure codec based on codec selection
            let codecType: 'avc' | 'hevc' | 'vp9' | 'av1';
            let codec: string;

            if (codecChoice === 'h264') {
                codecType = 'avc';
                codec = height < 1080 ? 'avc1.420028' : 'avc1.640033'; // H.264 Constrained Baseline/High profile
            } else if (codecChoice === 'h265') {
                codecType = 'hevc';
                codec = 'hev1.1.6.L120.B0'; // H.265 Main profile, Level 4.0
            } else if (codecChoice === 'vp9') {
                codecType = 'vp9';
                codec = 'vp09.00.10.08'; // VP9 Profile 0, Level 1.0
            } else if (codecChoice === 'av1') {
                codecType = 'av1';
                codec = 'av01.0.05M.08'; // AV1 Main Profile, Level 3.1
            } else {
                codecType = 'avc';
                codec = height < 1080 ? 'avc1.420028' : 'avc1.640033'; // Default: H.264 Constrained Baseline/High
            }

            const output = new Output({
                format: outputFormat,
                target
            });

            const videoSource = new EncodedVideoPacketSource(codecType);
            output.addVideoTrack(videoSource, {
                rotation: 0,
                frameRate
            });

            await output.start();

            const encoder = new VideoEncoder({
                output: async (chunk, meta) => {
                    const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                    await videoSource.add(encodedPacket, meta);
                },
                error: (error) => {
                    console.log(error);
                }
            });

            encoder.configure({
                codec,
                width,
                height,
                bitrate
            });

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.entity.camera.clearColor.copy(events.invoke('bgClr'));
            }
            scene.lockedRenderMode = true;

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);
            const line = new Uint8Array(width * 4);

            // get the list of visible splats
            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);

            // remember last camera position so we can skip sorting if the camera didn't move
            const last_pos = new Vec3(0, 0, 0);
            const last_forward = new Vec3(1, 0, 0);

            // prepare the frame for rendering
            const prepareFrame = async (frameTime: number) => {
                events.fire('timeline.time', frameTime);

                // manually update the camera so position and rotation are correct
                scene.camera.onUpdate(0);

                // if the camera didn't move, don't sort
                const pos = scene.camera.entity.getPosition();
                const forward = scene.camera.entity.forward;
                if (last_pos.equals(pos) && last_forward.equals(forward)) {
                    return;
                }

                // update remembered position
                last_pos.copy(pos);
                last_forward.copy(forward);

                // wait for sorting to complete
                await Promise.all(splats.map((splat) => {
                    // create a promise for each splat that will resolve upon sorting complete
                    return new Promise<void>((resolve) => {
                        const { instance } = splat.entity.gsplat;

                        // listen for the sorter to complete
                        const handle = instance.sorter.on('updated', () => {
                            handle.off();
                            resolve();
                        });

                        // manually invoke sort because internally the engine sorts after render the
                        // scene call is made.
                        instance.sort(scene.camera.entity);

                        // in cases where the camera does not move between frames the sorter won't run
                        // and we need a timeout instead. this is a hack - the engine should allow us to
                        // know whether the sorter is running or not.
                        setTimeout(() => {
                            resolve();
                        }, 1000);
                    });
                }));
            };

            // capture the current video frame
            const captureFrame = async (frameTime: number) => {
                const { renderTarget } = scene.camera.entity.camera;
                const { workRenderTarget } = scene.camera;

                scene.dataProcessor.copyRt(renderTarget, workRenderTarget);

                // read the rendered frame
                await workRenderTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workRenderTarget, data });

                // flip the buffer vertically
                for (let y = 0; y < height / 2; y++) {
                    const top = y * width * 4;
                    const bottom = (height - y - 1) * width * 4;
                    line.set(data.subarray(top, top + width * 4));
                    data.copyWithin(top, bottom, bottom + width * 4);
                    data.set(line, bottom);
                }

                // construct the video frame
                const videoFrame = new VideoFrame(data, {
                    format: 'RGBA',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp: Math.floor(1e6 * frameTime),
                    duration: Math.floor(1e6 / frameRate)
                });
                encoder.encode(videoFrame);
                videoFrame.close();
            };

            const animFrameRate = events.invoke('timeline.frameRate');
            const duration = (endFrame - startFrame) / animFrameRate;

            for (let frameTime = 0; frameTime <= duration; frameTime += 1.0 / frameRate) {
                // special case the first frame
                await prepareFrame(startFrame + frameTime * animFrameRate);

                // render a frame
                scene.lockedRender = true;

                // wait for render to finish
                await postRender();

                // wait for capture
                await captureFrame(frameTime);

                events.fire('progressUpdate', {
                    text: localize('panel.render.rendering', { ellipsis: true }),
                    progress: 100 * frameTime / duration
                });
            }

            // Flush and finalize output
            await encoder.flush();
            await output.finalize();

            // Free resources
            encoder.close();

            // Download
            if (!fileStream) {
                downloadFile((output.target as BufferTarget).buffer, `${removeExtension(splats[0]?.name ?? 'supersplat')}.${fileExtension}`);
            }

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('render.failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.entity.camera.clearColor.set(0, 0, 0, 0);
            scene.lockedRenderMode = false;
            scene.forceRender = true;       // camera likely moved, finish with normal render

            events.fire('progressEnd');
        }
    });

    events.function('render.sequence', async (sequenceSettings: SequenceSettings, directoryHandle: FileSystemDirectoryHandle) => {
        events.fire('progressStart', localize('panel.render.render-sequence'));

        try {
            const { startFrame, endFrame, width, height, transparentBg, showDebug } = sequenceSettings;
            const motionBlurSamples = Math.max(1, Math.floor(Number(sequenceSettings.motionBlurSamples ?? 1)));
            const hasMotionBlur = motionBlurSamples > 1;

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.entity.camera.clearColor.copy(events.invoke('bgClr'));
            }
            scene.lockedRenderMode = true;

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            // Reuse canvas and buffers to avoid memory leaks (create once, reuse for all frames)
            const reusableCanvas = sequenceSettings.format === 'jpeg' ? document.createElement('canvas') : null;
            if (reusableCanvas) {
                reusableCanvas.width = width;
                reusableCanvas.height = height;
            }
            const reusableCtx = reusableCanvas ? reusableCanvas.getContext('2d', { willReadFrequently: false }) : null;
            const reusableImageData = reusableCtx ? reusableCtx.createImageData(width, height) : null;
            const reusableFlippedData = sequenceSettings.format === 'jpeg' ? new Uint8Array(width * height * 4) : null;

            // get the list of visible splats
            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);

            // remember last camera position so we can skip sorting if the camera didn't move
            const last_pos = new Vec3(0, 0, 0);
            const last_forward = new Vec3(1, 0, 0);

            // prepare the frame for rendering (same as video export)
            const prepareFrame = async (frameTime: number, skipSort: boolean = false) => {
                events.fire('timeline.time', frameTime);

                // manually update the camera so position and rotation are correct
                scene.camera.onUpdate(0);

                // if the camera didn't move, don't sort
                const pos = scene.camera.entity.getPosition();
                const forward = scene.camera.entity.forward;
                if (last_pos.equals(pos) && last_forward.equals(forward)) {
                    return;
                }

                // update remembered position
                last_pos.copy(pos);
                last_forward.copy(forward);

                if (skipSort) {
                    return;
                }

                // wait for sorting to complete
                await Promise.all(splats.map((splat) => {
                    return new Promise<void>((resolve) => {
                        const { instance } = splat.entity.gsplat;

                        const handle = instance.sorter.on('updated', () => {
                            handle.off();
                            resolve();
                        });

                        instance.sort(scene.camera.entity);

                        setTimeout(() => {
                            resolve();
                        }, 1000);
                    });
                }));
            };

            // capture frame data (returns buffer copy for async processing)
            const captureFrame = async (frameNumber: number, targetBuffer?: Uint8Array): Promise<Uint8Array> => {
                const { renderTarget } = scene.camera.entity.camera;
                const { workRenderTarget } = scene.camera;

                scene.dataProcessor.copyRt(renderTarget, workRenderTarget);

                // read the rendered frame
                await workRenderTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workRenderTarget, data });

                // Copy buffer so downstream async work is safe; reuse provided buffer when possible
                const bufferCopy = (targetBuffer && targetBuffer.length === data.length) ? targetBuffer : new Uint8Array(data.length);
                bufferCopy.set(data);

                // the render buffer contains premultiplied alpha. so apply background color.
                if (!transparentBg) {
                    const bgClr = events.invoke('bgClr');
                    const { r, g, b } = bgClr;
                    for (let i = 0; i < bufferCopy.length; i += 4) {
                        const a = 255 - bufferCopy[i + 3];
                        bufferCopy[i + 0] += r * a;
                        bufferCopy[i + 1] += g * a;
                        bufferCopy[i + 2] += b * a;
                        bufferCopy[i + 3] = 255;
                    }
                }

                return bufferCopy;
            };

            // compress and save frame (can run in parallel)
            const compressAndSaveFrame = async (frameNumber: number, bufferCopy: Uint8Array): Promise<void> => {
                let arrayBuffer: ArrayBuffer;
                const frameNumberStr = String(frameNumber).padStart(6, '0');

                if (sequenceSettings.format === 'jpeg') {
                    // Try WebCodecs ImageEncoder first (hardware-accelerated, much faster)
                    // Check if ImageEncoder is available (Chrome 94+, Edge 94+)
                    const ImageEncoder = (window as any).ImageEncoder;
                    if (ImageEncoder) {
                        let imageBitmap: ImageBitmap | null = null;
                        try {
                            // Reuse canvas and buffers to avoid memory leaks
                            if (!reusableCanvas || !reusableCtx || !reusableImageData || !reusableFlippedData) {
                                throw new Error('Reusable resources not available');
                            }
                            
                            // Flip vertically for JPEG (canvas coordinate system)
                            for (let y = 0; y < height; y++) {
                                const srcRow = y * width * 4;
                                const dstRow = (height - 1 - y) * width * 4;
                                reusableFlippedData.set(bufferCopy.subarray(srcRow, srcRow + width * 4), dstRow);
                            }
                            
                            reusableImageData.data.set(reusableFlippedData);
                            reusableCtx.putImageData(reusableImageData, 0, 0);
                            
                            imageBitmap = await createImageBitmap(reusableCanvas);
                            
                            // Use WebCodecs ImageEncoder
                            arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
                                const chunks: Uint8Array[] = [];
                                let encoderClosed = false;
                                
                                const encoder = new ImageEncoder({
                                    output: (chunk: any) => {
                                        // Collect encoded chunks
                                        const data = new Uint8Array(chunk.data);
                                        chunks.push(data);
                                        
                                        // JPEG encoding typically completes in one chunk
                                        // Resolve when we have the data
                                        if (!encoderClosed) {
                                            encoderClosed = true;
                                            encoder.close();
                                            imageBitmap.close();
                                            
                                            // Combine all chunks into single buffer
                                            const totalLength = chunks.reduce((sum, arr) => sum + arr.length, 0);
                                            const result = new Uint8Array(totalLength);
                                            let offset = 0;
                                            for (const chunkData of chunks) {
                                                result.set(chunkData, offset);
                                                offset += chunkData.length;
                                            }
                                            resolve(result.buffer);
                                        }
                                    },
                                    error: (error: any) => {
                                        if (!encoderClosed) {
                                            encoderClosed = true;
                                            encoder.close();
                                            imageBitmap.close();
                                        }
                                        reject(error);
                                    }
                                });
                                
                                // Configure encoder for JPEG
                                const quality = Math.round((sequenceSettings.jpegQuality ?? 0.92) * 100);
                                try {
                                    encoder.configure({
                                        codec: 'jpeg',
                                        quality: quality
                                    });
                                    
                                    // Encode the frame
                                    encoder.encode(imageBitmap);
                                    
                                    // Flush to ensure encoding completes
                                    encoder.flush().catch((error: any) => {
                                        if (!encoderClosed) {
                                            encoderClosed = true;
                                            encoder.close();
                                            imageBitmap.close();
                                            reject(error);
                                        }
                                    });
                                } catch (error) {
                                    if (!encoderClosed) {
                                        encoderClosed = true;
                                        encoder.close();
                                        imageBitmap.close();
                                    }
                                    reject(error);
                                }
                            });
                        } catch (error) {
                            // Ensure ImageBitmap is closed even on error
                            if (imageBitmap) {
                                imageBitmap.close();
                                imageBitmap = null;
                            }
                            // Fall back to canvas.toBlob if WebCodecs fails
                            console.warn('WebCodecs ImageEncoder failed, falling back to canvas:', error);
                            arrayBuffer = undefined; // Force fallback
                        }
                    }
                    
                    // Fallback to canvas.toBlob if WebCodecs not available or failed
                    if (!arrayBuffer) {
                        // Reuse canvas and buffers
                        if (!reusableCanvas || !reusableCtx || !reusableImageData || !reusableFlippedData) {
                            throw new Error('Reusable resources not available for fallback');
                        }
                        
                        // Flip vertically for JPEG (canvas coordinate system)
                        for (let y = 0; y < height; y++) {
                            const srcRow = y * width * 4;
                            const dstRow = (height - 1 - y) * width * 4;
                            reusableFlippedData.set(bufferCopy.subarray(srcRow, srcRow + width * 4), dstRow);
                        }
                        
                        // Copy flipped RGBA data to ImageData
                        reusableImageData.data.set(reusableFlippedData);
                        reusableCtx.putImageData(reusableImageData, 0, 0);

                        // Encode as JPEG using canvas.toBlob (async but fast)
                        arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
                            reusableCanvas!.toBlob((blob: Blob | null) => {
                                if (blob) {
                                    blob.arrayBuffer().then(resolve).catch(reject);
                                } else {
                                    reject(new Error('Failed to encode JPEG'));
                                }
                            }, 'image/jpeg', sequenceSettings.jpegQuality ?? 0.92);
                        });
                    }

                    const filename = `frame_${frameNumberStr}.jpg`;
                    if (directoryHandle) {
                        try {
                            const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
                            const writable = await fileHandle.createWritable();
                            await writable.write(arrayBuffer);
                            await writable.close();
                            console.log(`Exported: ${filename}`);
                        } catch (error) {
                            console.error(`Failed to save ${filename}:`, error);
                            throw error;
                        }
                    }
                } else {
                    // PNG compression (slower but lossless)
                    if (!compressor) {
                        compressor = new PngCompressor();
                    }

                    arrayBuffer = await compressor.compress(
                        new Uint32Array(bufferCopy.buffer),
                        width,
                        height
                    );

                    const filename = `frame_${frameNumberStr}.png`;
                    if (directoryHandle) {
                        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(arrayBuffer);
                        await writable.close();
                    }
                }
            };

            const totalSourceFrames = endFrame - startFrame + 1;
            const totalExportFrames = Math.ceil(totalSourceFrames / motionBlurSamples);
            let completedFrames = 0;

            const updateProgress = (framesDone: number, framesTotal: number, sampleIndex: number, sampleTotal: number) => {
                events.fire('progressUpdate', {
                    text: `${localize('panel.render.rendering', { ellipsis: true })} (${framesDone+1} / ${framesTotal+1})\nSample (${sampleIndex+1} / ${sampleTotal+1})`,
                    progress: framesTotal > 0 ? (100 * framesDone / framesTotal) : 0
                });
            };

            // Accumulation buffer for motion blur (only used if motionBlurSamples > 1)
            const motionBlurAccumulator = hasMotionBlur ? new Float32Array(width * height * 4) : null;
            // Reusable buffers to minimize allocations
            const sampleBuffer = new Uint8Array(width * height * 4);
            const averagedBuffer = hasMotionBlur ? new Uint8Array(width * height * 4) : null;

            // Warmup: render the first frame twice to ensure camera properties are properly initialized
            if (totalSourceFrames > 0) {
                await prepareFrame(startFrame);
                scene.lockedRender = true;
                await postRender();
                // Now render it again for the actual capture
            }

            // Render frames with motion blur support
            let exportFrameIndex = 0;
            for (let sourceFrame = startFrame; sourceFrame <= endFrame; sourceFrame += motionBlurSamples) {
                // Accumulate N frames for motion blur
                if (hasMotionBlur && motionBlurAccumulator) {
                    // Reset accumulator
                    motionBlurAccumulator.fill(0);
                    
                    // Accumulate N consecutive frames, but skip the first as a warmup to avoid ghosting
                    const sampleEnd = Math.min(sourceFrame + motionBlurSamples - 1, endFrame);
                    const groupSamples = sampleEnd - sourceFrame + 1;
                    const accumulateStart = groupSamples > 1 ? sourceFrame + 1 : sourceFrame;
                    const actualSamples = groupSamples > 1 ? groupSamples - 1 : 1;
                    
                    // Warmup sample (not accumulated)
                    await prepareFrame(sourceFrame, false);
                    scene.lockedRender = true;
                    scene.forceRender = true;
                    await postRender();
                    await captureFrame(sourceFrame, sampleBuffer); // discard
                    updateProgress(completedFrames, totalExportFrames, 0, actualSamples);
                    
                    let sampleIdx = 0;
                    for (let sampleFrame = accumulateStart; sampleFrame <= sampleEnd; sampleFrame++) {
                        // Sort only on the first accumulated sample; reuse order for the rest
                        const skipSort = sampleFrame !== accumulateStart;
                        await prepareFrame(sampleFrame, skipSort);
                        scene.lockedRender = true;
                        scene.forceRender = true; // ensure a fresh render for each sample
                        await postRender();
                        
                        const bufferCopy = await captureFrame(sampleFrame, sampleBuffer);
                        
                        // Accumulate into motion blur buffer (as floats for precision)
                        for (let i = 0; i < bufferCopy.length; i++) {
                            motionBlurAccumulator[i] += bufferCopy[i];
                        }
                        sampleIdx++;
                        updateProgress(completedFrames, totalExportFrames, sampleIdx, actualSamples);
                    }
                    
                    // Average by dividing by number of samples
                    if (!averagedBuffer) {
                        throw new Error('Averaged buffer not available');
                    }
                    for (let i = 0; i < motionBlurAccumulator.length; i++) {
                        averagedBuffer[i] = Math.round(motionBlurAccumulator[i] / actualSamples);
                    }
                    
                    // Export the averaged frame sequentially (one at a time)
                    const exportFrameNumber = startFrame + exportFrameIndex;
                    await compressAndSaveFrame(exportFrameNumber, averagedBuffer);
                    completedFrames++;
                    updateProgress(completedFrames, totalExportFrames, actualSamples, actualSamples);
                    exportFrameIndex++;
                } else {
                    // No motion blur - export each frame normally
                    await prepareFrame(sourceFrame);
                    scene.lockedRender = true;
                    scene.forceRender = true; // force render so motion is captured per frame
                    await postRender();
                    
                    const bufferCopy = await captureFrame(sourceFrame, sampleBuffer);
                    
                    await compressAndSaveFrame(sourceFrame, bufferCopy);
                    completedFrames++;
                    updateProgress(completedFrames, totalExportFrames, 1, 1);
                }
            }

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('render.failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.entity.camera.clearColor.set(0, 0, 0, 0);
            scene.lockedRenderMode = false;
            scene.forceRender = true;

            events.fire('progressEnd');
        }
    });
};

export { ImageSettings, VideoSettings, SequenceSettings, registerRenderEvents };
