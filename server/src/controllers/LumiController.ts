import { BrowserWindow } from 'electron';
import fs from 'fs-extra';
import _path from 'path';
import i18next from 'i18next';
import Sentry from '@sentry/node';
import * as H5P from '@lumieducation/h5p-server';
import LumiError from '../helpers/LumiError';
import Logger from '../helpers/Logger';
import User from '../h5pImplementations/User';
import IServerConfig from '../config/IPaths';
import StateStorage from '../state/electronState';
import { sanitizeFilename } from '../helpers/FilenameSanitizer';
import { IFilePickers } from '../types';
import FileHandle from '../state/FileHandle';
import FileHandleManager from '../state/FileHandleManager';

const log = new Logger('controller:lumi-h5p');

const t = i18next.getFixedT(null, 'lumi');

export default class LumiController {
    constructor(
        private h5pEditor: H5P.H5PEditor,
        serverConfig: IServerConfig,
        private browserWindow: BrowserWindow,
        private electronState: StateStorage,
        private filePickers: IFilePickers,
        private fileHandleManager: FileHandleManager
    ) {
        fs.readJSON(serverConfig.settingsFile).then((settings) => {
            if (settings.privacyPolicyConsent) {
                h5pEditor.contentTypeCache.updateIfNecessary();
            }
        });
    }

    public async delete(contentId: string): Promise<void> {
        return this.h5pEditor.deleteContent(contentId, new User());
    }

    public async export(
        contentId: string,
        fileHandleId?: string
    ): Promise<{ fileHandleId: string; path: string }> {
        try {
            const { params } = await this.h5pEditor.getContent(
                contentId,
                new User()
            );

            let fileHandle: FileHandle =
                this.fileHandleManager.getById(fileHandleId);
            if (!fileHandle) {
                fileHandle = await this.filePickers.saveFile(
                    ['h5p'],
                    t('editor.extensionName'),
                    _path.join(
                        this.electronState.getState().lastDirectory,
                        sanitizeFilename(
                            params?.metadata?.title,
                            t('editor.saveAsDialog.fallbackFilename')
                        ) ?? t('editor.saveAsDialog.fallbackFilename')
                    ),
                    t('editor.saveAsDialog.title'),
                    undefined,
                    this.browserWindow
                );
            }
            if (!fileHandle) {
                throw new LumiError('user-abort', 'Aborted by user', 499);
            }

            this.electronState.setState({
                lastDirectory: _path.dirname(fileHandle.filename)
            });

            let path = fileHandle.filename;
            if (_path.extname(path) !== '.h5p') {
                path = `${path}.h5p`;
            }

            this.electronState.setState({ blockKeyboard: true });

            const stream = fs.createWriteStream(path);
            const packageExporter = new H5P.PackageExporter(
                this.h5pEditor.libraryManager,
                this.h5pEditor.contentStorage,
                this.h5pEditor.config
            );
            await packageExporter.createPackage(contentId, stream, new User());
            // We also need to wait for the stream to finish before returning, so
            // that the user is notified correctly about fact that saving is still
            // going on.
            await new Promise<void>((y, n) => {
                stream.on('finish', () => {
                    y();
                });
            }).finally(() => {
                this.electronState.setState({ blockKeyboard: false });
            });

            return {
                fileHandleId: fileHandle.handleId,
                path: fileHandle.filename
            };
        } catch (error: any) {
            this.electronState.setState({ blockKeyboard: false });
            Sentry.captureException(error);
        }
    }

    public async import(fileHandleId: string): Promise<{
        id: string;
        library: string;
        metadata: H5P.IContentMetadata;
        parameters: any;
    }> {
        const path = this.fileHandleManager.getById(fileHandleId)?.filename;
        if (!path) {
            throw new Error('File not selected before');
        }

        const buffer = await fs.readFile(path);

        const { metadata, parameters } = await this.h5pEditor.uploadPackage(
            buffer,
            new User()
        );

        const id = await this.h5pEditor.saveOrUpdateContent(
            undefined,
            parameters,
            metadata,
            this.getUbernameFromH5pJson(metadata),
            new User()
        );

        return {
            id,
            metadata,
            parameters,
            library: this.getUbernameFromH5pJson(metadata)
        };
    }

    public async loadPackage(contentId: string): Promise<{
        h5p: H5P.IContentMetadata;
        library: string;
        params: {
            metadata: H5P.IContentMetadata;
            params: H5P.ContentParameters;
        };
    }> {
        log.info(`loading package with contentId ${contentId}`);
        return this.h5pEditor.getContent(contentId);
    }

    public async pickCSSFile(): Promise<{ fileHandle: string; path: string }> {
        const fileHandle = await this.filePickers.openSingleFile(
            ['css'],
            t('editor.exportDialog.cssFilePicker.formatName'),
            this.electronState.getState().lastDirectory,
            this.browserWindow
        );

        if (fileHandle) {
            this.electronState.setState({
                lastDirectory: _path.dirname(fileHandle.filename)
            });
        }

        return { fileHandle: fileHandle.handleId, path: fileHandle.filename };
    }

    public async pickH5PFiles(): Promise<
        { fileHandleId: string; path: string }[]
    > {
        const fileHandles = await this.filePickers.openMultipleFiles(
            ['h5p'],
            t('editor.extensionName'),
            this.electronState.getState().lastDirectory,
            this.browserWindow
        );

        if (
            fileHandles &&
            fileHandles.length > 0 &&
            fileHandles[0] !== undefined
        ) {
            this.electronState.setState({
                lastDirectory: _path.dirname(fileHandles[0].filename)
            });
        } else {
            return undefined;
        }

        return fileHandles.map((fh) => ({
            fileHandleId: fh.handleId,
            path: fh.filename
        }));
    }

    public setBrowserWindow(browserWindow: BrowserWindow): void {
        this.browserWindow = browserWindow;
    }

    public async update(
        parameters: any,
        metadata: H5P.IContentMetadata,
        library: string,
        argId?: string
    ): Promise<{
        id: string;
        library: string;
        metadata: H5P.IContentMetadata;
        parameters: any;
    }> {
        let id: any;
        if (argId !== 'undefined') {
            id = argId;
        }

        if (id && !(await this.h5pEditor.contentManager.contentExists(id))) {
            throw new LumiError('h5p-not-found', 'content not found', 404);
        }

        const contentId = await this.h5pEditor.saveOrUpdateContent(
            id,
            parameters,
            metadata,
            library,
            new User()
        );

        return {
            library,
            metadata,
            parameters,
            id: contentId
        };
    }

    private getUbernameFromH5pJson(h5pJson: H5P.IContentMetadata): string {
        const library = (h5pJson.preloadedDependencies || []).find(
            (dependency) => dependency.machineName === h5pJson.mainLibrary
        );
        if (!library) {
            return '';
        }
        return H5P.LibraryName.toUberName(library, { useWhitespace: true });
    }
}
