/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import * as platform from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { createRemoteURITransformer } from 'vs/server/remoteUriTransformer';
import { IRemoteAgentEnvironmentDTO, IGetEnvironmentDataArguments, IScanExtensionsArguments } from 'vs/workbench/services/remote/common/remoteAgentEnvironmentChannel';
import * as nls from 'vs/nls';
import * as pfs from 'vs/base/node/pfs';
import { Schemas } from 'vs/base/common/network';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import product from 'vs/platform/product/common/product';
import { ExtensionScanner, ExtensionScannerInput, IExtensionResolver, IExtensionReference } from 'vs/workbench/services/extensions/node/extensionPoints';
import { IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { getPathFromAmdModule } from 'vs/base/common/amd';
import { ExtensionIdentifier, IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { transformOutgoingURIs } from 'vs/base/common/uriIpc';
import { ILogService } from 'vs/platform/log/common/log';
import { getNLSConfiguration, InternalNLSConfiguration } from 'vs/server/remoteLanguagePacks';
import { ContextKeyExpr, ContextKeyDefinedExpr, ContextKeyNotExpr, ContextKeyEqualsExpr, ContextKeyNotEqualsExpr, ContextKeyRegexExpr, IContextKeyExprMapper, ContextKeyExpression, ContextKeyInExpr } from 'vs/platform/contextkey/common/contextkey';
import { listProcesses } from 'vs/base/node/ps';
import { getMachineInfo, collectWorkspaceStats } from 'vs/platform/diagnostics/node/diagnosticsService';
import { IDiagnosticInfoOptions, IDiagnosticInfo } from 'vs/platform/diagnostics/common/diagnostics';
import { basename, join, normalize } from 'vs/base/common/path';
import { ProcessItem } from 'vs/base/common/processes';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ILog, Translations } from 'vs/workbench/services/extensions/common/extensionPoints';
import { ITelemetryAppender } from 'vs/platform/telemetry/common/telemetryUtils';
import { IBuiltInExtension } from 'vs/platform/product/common/productService';

let _SystemExtensionsRoot: string | null = null;
function getSystemExtensionsRoot(): string {
	if (!_SystemExtensionsRoot) {
		_SystemExtensionsRoot = normalize(join(getPathFromAmdModule(require, ''), '..', 'extensions'));
	}
	return _SystemExtensionsRoot;
}
let _ExtraDevSystemExtensionsRoot: string | null = null;
function getExtraDevSystemExtensionsRoot(): string {
	if (!_ExtraDevSystemExtensionsRoot) {
		_ExtraDevSystemExtensionsRoot = normalize(join(getPathFromAmdModule(require, ''), '..', '.build', 'builtInExtensions'));
	}
	return _ExtraDevSystemExtensionsRoot;
}

export class RemoteAgentEnvironmentChannel implements IServerChannel {

	private static _namePool = 1;
	private readonly _logger: ILog;

	constructor(
		private readonly _connectionToken: string,
		private readonly environmentService: INativeEnvironmentService,
		private readonly logService: ILogService,
		private readonly telemetryService: ITelemetryService,
		private readonly telemetryAppender: ITelemetryAppender | null
	) {
		this._logger = new class implements ILog {
			public error(source: string, message: string): void {
				logService.error(source, message);
			}
			public warn(source: string, message: string): void {
				logService.warn(source, message);
			}
			public info(source: string, message: string): void {
				logService.info(source, message);
			}
		};
	}

	async call(_: any, command: string, arg?: any): Promise<any> {
		switch (command) {
			case 'disableTelemetry': {
				this.telemetryService.setEnabled(false);
				return;
			}

			case 'getEnvironmentData': {
				const args = <IGetEnvironmentDataArguments>arg;
				const uriTransformer = createRemoteURITransformer(args.remoteAuthority);

				let environmentData = await this.getEnvironmentData();
				environmentData = transformOutgoingURIs(environmentData, uriTransformer);

				return environmentData;
			}

			case 'scanExtensions': {
				const args = <IScanExtensionsArguments>arg;
				const language = args.language;
				this.logService.trace(`Scanning extensions using UI language: ${language}`);
				const uriTransformer = createRemoteURITransformer(args.remoteAuthority);

				const extensionDevelopmentLocations = args.extensionDevelopmentPath && args.extensionDevelopmentPath.map(url => URI.revive(uriTransformer.transformIncoming(url)));
				const extensionDevelopmentPath = extensionDevelopmentLocations ? extensionDevelopmentLocations.filter(url => url.scheme === Schemas.file).map(url => url.fsPath) : undefined;

				let extensions = await this.scanExtensions(language, extensionDevelopmentPath);
				extensions = transformOutgoingURIs(extensions, uriTransformer);

				RemoteAgentEnvironmentChannel.massageWhenConditions(extensions);

				return extensions;
			}

			case 'getDiagnosticInfo': {
				const options = <IDiagnosticInfoOptions>arg;
				const diagnosticInfo: IDiagnosticInfo = {
					machineInfo: getMachineInfo()
				};

				const processesPromise: Promise<ProcessItem | void> = options.includeProcesses ? listProcesses(process.pid) : Promise.resolve();

				let workspaceMetadataPromises: Promise<void>[] = [];
				const workspaceMetadata: { [key: string]: any } = {};
				if (options.folders) {
					// only incoming paths are transformed, so remote authority is unneeded.
					const uriTransformer = createRemoteURITransformer('');
					const folderPaths = options.folders
						.map(folder => URI.revive(uriTransformer.transformIncoming(folder)))
						.filter(uri => uri.scheme === 'file');

					workspaceMetadataPromises = folderPaths.map(folder => {
						return collectWorkspaceStats(folder.fsPath, ['node_modules', '.git'])
							.then(stats => {
								workspaceMetadata[basename(folder.fsPath)] = stats;
							});
					});
				}

				return Promise.all([processesPromise, ...workspaceMetadataPromises]).then(([processes, _]) => {
					diagnosticInfo.processes = processes || undefined;
					diagnosticInfo.workspaceMetadata = options.folders ? workspaceMetadata : undefined;
					return diagnosticInfo;
				});
			}

			case 'logTelemetry': {
				const { eventName, data } = arg;
				// Logging is done directly to the appender instead of through the telemetry service
				// as the data sent from the client has already had common properties added to it and
				// has already been sent to the telemetry output channel
				if (this.telemetryAppender) {
					return this.telemetryAppender.log(eventName, data);
				}

				return Promise.resolve();
			}

			case 'flushTelemetry': {
				if (this.telemetryAppender) {
					return this.telemetryAppender.flush();
				}

				return Promise.resolve();
			}
		}

		throw new Error(`IPC Command ${command} not found`);
	}

	listen(_: any, event: string, arg: any): Event<any> {
		throw new Error('Not supported');
	}

	private static massageWhenConditions(extensions: IExtensionDescription[]): void {
		// We must massage "when" conditions which mention `resourceScheme`
		// See https://github.com/Microsoft/vscode-remote/issues/663

		interface WhenUser { when?: string; }

		interface LocWhenUser { [loc: string]: WhenUser[]; }

		const _mapResourceSchemeValue = (value: string, isRegex: boolean): string => {
			// console.log(`_mapResourceSchemeValue: ${value}, ${isRegex}`);
			return value.replace(/file/g, 'vscode-remote');
		};

		const _mapResourceRegExpValue = (value: RegExp): RegExp => {
			let flags = '';
			flags += value.global ? 'g' : '';
			flags += value.ignoreCase ? 'i' : '';
			flags += value.multiline ? 'm' : '';
			return new RegExp(_mapResourceSchemeValue(value.source, true), flags);
		};

		const _exprKeyMapper = new class implements IContextKeyExprMapper {
			mapDefined(key: string): ContextKeyExpression {
				return ContextKeyDefinedExpr.create(key);
			}
			mapNot(key: string): ContextKeyExpression {
				return ContextKeyNotExpr.create(key);
			}
			mapEquals(key: string, value: any): ContextKeyExpression {
				if (key === 'resourceScheme' && typeof value === 'string') {
					return ContextKeyEqualsExpr.create(key, _mapResourceSchemeValue(value, false));
				} else {
					return ContextKeyEqualsExpr.create(key, value);
				}
			}
			mapNotEquals(key: string, value: any): ContextKeyExpression {
				if (key === 'resourceScheme' && typeof value === 'string') {
					return ContextKeyNotEqualsExpr.create(key, _mapResourceSchemeValue(value, false));
				} else {
					return ContextKeyNotEqualsExpr.create(key, value);
				}
			}
			mapRegex(key: string, regexp: RegExp | null): ContextKeyRegexExpr {
				if (key === 'resourceScheme' && regexp) {
					return ContextKeyRegexExpr.create(key, _mapResourceRegExpValue(regexp));
				} else {
					return ContextKeyRegexExpr.create(key, regexp);
				}
			}
			mapIn(key: string, valueKey: string): ContextKeyInExpr {
				return ContextKeyInExpr.create(key, valueKey);
			}
		};

		const _massageWhenUser = (element: WhenUser) => {
			if (!element || !element.when || !/resourceScheme/.test(element.when)) {
				return;
			}

			const expr = ContextKeyExpr.deserialize(element.when);
			if (!expr) {
				return;
			}

			const massaged = expr.map(_exprKeyMapper);
			element.when = massaged.serialize();
		};

		const _massageWhenUserArr = (elements: WhenUser[] | WhenUser) => {
			if (Array.isArray(elements)) {
				for (let element of elements) {
					_massageWhenUser(element);
				}
			} else {
				_massageWhenUser(elements);
			}
		};

		const _massageLocWhenUser = (target: LocWhenUser) => {
			for (let loc in target) {
				_massageWhenUserArr(target[loc]);
			}
		};

		extensions.forEach((extension) => {
			if (extension.contributes) {
				if (extension.contributes.menus) {
					_massageLocWhenUser(<LocWhenUser>extension.contributes.menus);
				}
				if (extension.contributes.keybindings) {
					_massageWhenUserArr(<WhenUser | WhenUser[]>extension.contributes.keybindings);
				}
				if (extension.contributes.views) {
					_massageLocWhenUser(<LocWhenUser>extension.contributes.views);
				}
			}
		});
	}

	private async getEnvironmentData(): Promise<IRemoteAgentEnvironmentDTO> {
		return {
			pid: process.pid,
			connectionToken: this._connectionToken,
			appRoot: URI.file(this.environmentService.appRoot),
			settingsPath: this.environmentService.machineSettingsResource,
			logsPath: URI.file(this.environmentService.logsPath),
			extensionsPath: URI.file(this.environmentService.extensionsPath!),
			extensionHostLogsPath: URI.file(join(this.environmentService.logsPath, `exthost${RemoteAgentEnvironmentChannel._namePool++}`)),
			globalStorageHome: this.environmentService.globalStorageHome,
			workspaceStorageHome: this.environmentService.workspaceStorageHome,
			userHome: this.environmentService.userHome,
			os: platform.OS
		};
	}

	private scanExtensions(language: string, extensionDevelopmentPath?: string[]): Promise<IExtensionDescription[]> {
		// Ensure that the language packs are available
		return getNLSConfiguration(language, this.environmentService.userDataPath).then((config) => {
			if (InternalNLSConfiguration.is(config)) {
				return pfs.readFile(config._translationsConfigFile, 'utf8').then((content) => {
					return JSON.parse(content);
				}, (err) => {
					return Object.create(null);
				});
			} else {
				return Object.create(null);
			}
		}).then((translations: Translations) => {
			return Promise.all([
				this.scanBuiltinExtensions(language, translations),
				this.scanInstalledExtensions(language, translations),
				this.scanDevelopedExtensions(language, translations, extensionDevelopmentPath)
			]).then(([builtinExtensions, installedExtensions, developedExtensions]) => {
				let result = new Map<string, IExtensionDescription>();

				builtinExtensions.forEach((builtinExtension) => {
					if (!builtinExtension) {
						return;
					}
					result.set(ExtensionIdentifier.toKey(builtinExtension.identifier), builtinExtension);
				});

				installedExtensions.forEach((installedExtension) => {
					if (!installedExtension) {
						return;
					}
					if (result.has(ExtensionIdentifier.toKey(installedExtension.identifier))) {
						console.warn(nls.localize('overwritingExtension', "Overwriting extension {0} with {1}.", result.get(ExtensionIdentifier.toKey(installedExtension.identifier))!.extensionLocation.fsPath, installedExtension.extensionLocation.fsPath));
					}
					result.set(ExtensionIdentifier.toKey(installedExtension.identifier), installedExtension);
				});

				developedExtensions.forEach((developedExtension) => {
					if (!developedExtension) {
						return;
					}
					result.set(ExtensionIdentifier.toKey(developedExtension.identifier), developedExtension);
				});

				const r: IExtensionDescription[] = [];
				result.forEach((v) => r.push(v));
				return r;
			});
		});
	}

	private scanDevelopedExtensions(language: string, translations: Translations, extensionDevelopmentPaths?: string[]): Promise<IExtensionDescription[]> {

		if (extensionDevelopmentPaths) {

			const extDescsP = extensionDevelopmentPaths.map(extDevPath => {
				return ExtensionScanner.scanOneOrMultipleExtensions(
					new ExtensionScannerInput(
						product.version,
						product.commit,
						language,
						true, // dev mode
						extDevPath,
						false, // isBuiltin
						true, // isUnderDevelopment
						translations // translations
					), this._logger
				);
			});

			return Promise.all(extDescsP).then((extDescArrays: IExtensionDescription[][]) => {
				let extDesc: IExtensionDescription[] = [];
				for (let eds of extDescArrays) {
					extDesc = extDesc.concat(eds);
				}
				return extDesc;
			});
		}
		return Promise.resolve([]);
	}

	private scanBuiltinExtensions(language: string, translations: Translations): Promise<IExtensionDescription[]> {
		const version = product.version;
		const commit = product.commit;
		const devMode = !!process.env['VSCODE_DEV'];

		const input = new ExtensionScannerInput(version, commit, language, devMode, getSystemExtensionsRoot(), true, false, translations);
		const builtinExtensions = ExtensionScanner.scanExtensions(input, this._logger);
		let finalBuiltinExtensions: Promise<IExtensionDescription[]> = builtinExtensions;

		if (devMode) {

			class ExtraBuiltInExtensionResolver implements IExtensionResolver {
				constructor(private builtInExtensions: IBuiltInExtension[]) { }
				resolveExtensions(): Promise<IExtensionReference[]> {
					return Promise.resolve(this.builtInExtensions.map((ext) => {
						return { name: ext.name, path: join(getExtraDevSystemExtensionsRoot(), ext.name) };
					}));
				}
			}

			const builtInExtensions = Promise.resolve(product.builtInExtensions || []);

			const input = new ExtensionScannerInput(version, commit, language, devMode, getExtraDevSystemExtensionsRoot(), true, false, {});
			const extraBuiltinExtensions = builtInExtensions
				.then((builtInExtensions) => new ExtraBuiltInExtensionResolver(builtInExtensions))
				.then(resolver => ExtensionScanner.scanExtensions(input, this._logger, resolver));

			finalBuiltinExtensions = ExtensionScanner.mergeBuiltinExtensions(builtinExtensions, extraBuiltinExtensions);
		}

		return finalBuiltinExtensions;
	}

	private scanInstalledExtensions(language: string, translations: Translations): Promise<IExtensionDescription[]> {
		const input = new ExtensionScannerInput(
			product.version,
			product.commit,
			language,
			true,
			this.environmentService.extensionsPath!,
			false, // isBuiltin
			true, // isUnderDevelopment
			translations
		);

		return ExtensionScanner.scanExtensions(input, this._logger);
	}
}
