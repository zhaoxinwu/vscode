/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { Disposable, dispose, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { FindReplaceState } from 'vs/editor/contrib/find/findState';
import { EditorActivation, IResourceEditorInput } from 'vs/platform/editor/common/editor';
import { IInstantiationService, optional } from 'vs/platform/instantiation/common/instantiation';
import { ICreateTerminalOptions, IShellLaunchConfig, TerminalLocation } from 'vs/platform/terminal/common/terminal';
import { IEditorInput, isEditorInput } from 'vs/workbench/common/editor';
import { IRemoteTerminalService, ITerminalEditorService, ITerminalInstance, ITerminalInstanceService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { TerminalEditor } from 'vs/workbench/contrib/terminal/browser/terminalEditor';
import { TerminalEditorInput } from 'vs/workbench/contrib/terminal/browser/terminalEditorInput';
import { DeserializedTerminalEditorInput } from 'vs/workbench/contrib/terminal/browser/terminalEditorSerializer';
import { getInstanceFromResource, getTerminalUri, parseTerminalUri } from 'vs/workbench/contrib/terminal/browser/terminalUri';
import { ILocalTerminalService, IOffProcessTerminalService } from 'vs/workbench/contrib/terminal/common/terminal';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService, SIDE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { ILifecycleService } from 'vs/workbench/services/lifecycle/common/lifecycle';

export class TerminalEditorService extends Disposable implements ITerminalEditorService {
	declare _serviceBrand: undefined;

	instances: ITerminalInstance[] = [];
	private _activeInstanceIndex: number = -1;
	private _isShuttingDown = false;

	private _editorInputs: Map</*resource*/string, TerminalEditorInput> = new Map();
	private _launchConfigs: Map</*resource*/string, ICreateTerminalOptions> = new Map();
	private _instanceDisposables: Map</*resource*/string, IDisposable[]> = new Map();

	private readonly _primaryOffProcessTerminalService: IOffProcessTerminalService;

	private readonly _onDidDisposeInstance = new Emitter<ITerminalInstance>();
	readonly onDidDisposeInstance = this._onDidDisposeInstance.event;
	private readonly _onDidFocusInstance = new Emitter<ITerminalInstance>();
	readonly onDidFocusInstance = this._onDidFocusInstance.event;
	private readonly _onDidChangeActiveInstance = new Emitter<ITerminalInstance | undefined>();
	readonly onDidChangeActiveInstance = this._onDidChangeActiveInstance.event;
	private readonly _onDidChangeInstances = new Emitter<void>();
	readonly onDidChangeInstances = this._onDidChangeInstances.event;

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IRemoteTerminalService private readonly _remoteTerminalService: IRemoteTerminalService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@optional(ILocalTerminalService) private readonly _localTerminalService: ILocalTerminalService
	) {
		super();
		this._primaryOffProcessTerminalService = !!environmentService.remoteAuthority ? this._remoteTerminalService : (this._localTerminalService || this._remoteTerminalService);
		this._register(toDisposable(() => {
			for (const d of this._instanceDisposables.values()) {
				dispose(d);
			}
		}));
		this._register(lifecycleService.onWillShutdown(() => this._isShuttingDown = true));
		this._register(this._editorService.onDidActiveEditorChange(() => {
			const activeEditor = this._editorService.activeEditor;
			const instance = activeEditor instanceof TerminalEditorInput ? activeEditor?.terminalInstance : undefined;
			if (instance && activeEditor instanceof TerminalEditorInput) {
				activeEditor?.setGroup(this._editorService.activeEditorPane?.group);
				this._setActiveInstance(instance);
			}
		}));
		this._register(this._editorService.onDidVisibleEditorsChange(() => {
			// add any terminal editors created via the editor service split command
			const knownIds = this.instances.map(i => i.instanceId);
			const terminalEditors = this._getActiveTerminalEditors();
			const unknownEditor = terminalEditors.find(input => {
				const inputId = input instanceof TerminalEditorInput ? input.terminalInstance?.instanceId : undefined;
				if (inputId === undefined) {
					return false;
				}
				return !knownIds.includes(inputId);
			});
			if (unknownEditor instanceof TerminalEditorInput && unknownEditor.terminalInstance) {
				this._editorInputs.set(unknownEditor.terminalInstance.resource.path, unknownEditor);
				this.instances.push(unknownEditor.terminalInstance);
			}
		}));
		this._register(this.onDidDisposeInstance(instance => this.detachInstance(instance)));

		// Remove the terminal from the managed instances when the editor closes. This fires when
		// dragging and dropping to another editor or closing the editor via cmd/ctrl+w.
		this._register(this._editorService.onDidCloseEditor(e => {
			const instance = e.editor instanceof TerminalEditorInput ? e.editor.terminalInstance : undefined;
			if (instance) {
				const instanceIndex = this.instances.findIndex(e => e === instance);
				if (instanceIndex !== -1) {
					this.instances.splice(instanceIndex, 1);
				}
			}
		}));
	}

	private _getActiveTerminalEditors(): IEditorInput[] {
		return this._editorService.visibleEditors.filter(e => e instanceof TerminalEditorInput && e.terminalInstance?.instanceId);
	}

	private _getActiveTerminalEditor(): TerminalEditor | undefined {
		return this._editorService.activeEditorPane instanceof TerminalEditor ? this._editorService.activeEditorPane : undefined;
	}

	findPrevious(): void {
		const editor = this._getActiveTerminalEditor();
		editor?.showFindWidget();
		editor?.getFindWidget().find(true);
	}

	findNext(): void {
		const editor = this._getActiveTerminalEditor();
		editor?.showFindWidget();
		editor?.getFindWidget().find(false);
	}

	getFindState(): FindReplaceState {
		const editor = this._getActiveTerminalEditor();
		return editor!.findState!;
	}

	async focusFindWidget(): Promise<void> {
		const instance = this.activeInstance;
		if (instance) {
			await instance.focusWhenReady(true);
		}

		this._getActiveTerminalEditor()?.focusFindWidget();
	}

	hideFindWidget(): void {
		this._getActiveTerminalEditor()?.hideFindWidget();
	}

	get activeInstance(): ITerminalInstance | undefined {
		if (this.instances.length === 0 || this._activeInstanceIndex === -1) {
			return undefined;
		}
		return this.instances[this._activeInstanceIndex];
	}

	setActiveInstance(instance: ITerminalInstance): void {
		this._setActiveInstance(instance);
	}

	private _setActiveInstance(instance: ITerminalInstance | undefined): void {
		if (instance === undefined) {
			this._activeInstanceIndex = -1;
		} else {
			this._activeInstanceIndex = this.instances.findIndex(e => e === instance);
		}
		this._onDidChangeActiveInstance.fire(this.activeInstance);
	}

	async openEditor(resourceOrEditor: URI | ITerminalInstance, sideGroup: boolean = false, isFutureSplit?: boolean): Promise<void> {
		const resource = this.getOrCreateResource(resourceOrEditor);
		const editorOptions = {
			pinned: true,
			forceReload: true
		};
		console.log(resource);
		const targetGroup = sideGroup ? SIDE_GROUP : undefined;
		if (isEditorInput(resource)) {
			await this._editorService.openEditor(resource, editorOptions, targetGroup);
		} else {
			let resourceEditorInput: IResourceEditorInput;
			if (URI.isUri(resource)) {
				resourceEditorInput = {
					resource: resource,
					options: editorOptions
				};
				await this._editorService.openEditor(resourceEditorInput, targetGroup);
			}
		}
	}

	getOrCreateResource(instanceOrUri: ITerminalInstance | DeserializedTerminalEditorInput | URI, isFutureSplit: boolean = false): URI | TerminalEditorInput {
		const resource: URI = instanceOrUri && URI.isUri(instanceOrUri) ? instanceOrUri : instanceOrUri.resource;
		const inputKey = resource.path;
		const cachedEditor = this._editorInputs.get(inputKey);
		if (cachedEditor) {
			return cachedEditor;
		}

		if ('pid' in instanceOrUri) {
			instanceOrUri = this._terminalInstanceService.createInstance({ attachPersistentProcess: instanceOrUri }, TerminalLocation.Editor);
		} else if (URI.isUri(instanceOrUri)) {
			// Terminal from a different window
			const terminalIdentifier = parseTerminalUri(instanceOrUri);
			if (terminalIdentifier.instanceId) {
				this._primaryOffProcessTerminalService.requestDetachInstance(terminalIdentifier.workspaceId, terminalIdentifier.instanceId).then(attachPersistentProcess => {
					const createTerminalOptions: ICreateTerminalOptions = { config: { attachPersistentProcess }, target: TerminalLocation.Editor };
					this._launchConfigs.set(inputKey, createTerminalOptions);
					return resource;
				});
			}
		}
		if ('instanceId' in instanceOrUri) {
			instanceOrUri.target = TerminalLocation.Editor;
			const input = this._instantiationService.createInstance(TerminalEditorInput, resource, instanceOrUri);
			this._registerInstance(inputKey, input, instanceOrUri);
			return input;
		}
		return getTerminalUri('dfsldjfkdslfsjdflksdjf', 2, 'fake');
	}

	getInstance(resource: URI): ITerminalInstance | undefined {
		const launchConfig = this._launchConfigs.get(resource.path);
		if (launchConfig) {
			console.log('launchConfig', launchConfig);
			const instance = this._terminalInstanceService.createInstance(launchConfig, launchConfig.target, resource);
			return instance;
		}
		return undefined;
	}

	getInput(resource: URI): TerminalEditorInput | undefined {
		return this._editorInputs.get(resource.path);
	}

	private _registerInstance(inputKey: string, input: TerminalEditorInput, instance: ITerminalInstance): void {
		this._editorInputs.set(inputKey, input);
		this._instanceDisposables.set(inputKey, [
			instance.onDidFocus(this._onDidFocusInstance.fire, this._onDidFocusInstance),
			instance.onDisposed(this._onDidDisposeInstance.fire, this._onDidDisposeInstance)
		]);
		this.instances.push(instance);
		this._onDidChangeInstances.fire();
	}

	getInstanceFromResource(resource: URI | undefined): ITerminalInstance | undefined {
		return getInstanceFromResource(this.instances, resource);
	}

	splitInstance(instanceToSplit: ITerminalInstance, shellLaunchConfig: IShellLaunchConfig = {}): ITerminalInstance {
		if (instanceToSplit.target === TerminalLocation.Editor) {
			// Make sure the instance to split's group is active
			const group = this._editorInputs.get(instanceToSplit.resource.path)?.group;
			if (group) {
				this._editorGroupsService.activateGroup(group);
			}
		}
		const instance = this._terminalInstanceService.createInstance(shellLaunchConfig, TerminalLocation.Editor);
		this.openEditor(instance, undefined, true);
		return instance;
	}

	detachActiveEditorInstance(): ITerminalInstance {
		const activeEditor = this._editorService.activeEditor;
		if (!(activeEditor instanceof TerminalEditorInput)) {
			throw new Error('Active editor is not a terminal');
		}
		const instance = activeEditor.terminalInstance;
		if (!instance) {
			throw new Error('Terminal is already detached');
		}
		this.detachInstance(instance);
		return instance;
	}

	detachInstance(instance: ITerminalInstance) {
		const inputKey = instance.resource.path;
		const editorInput = this._editorInputs.get(inputKey);
		editorInput?.detachInstance();
		this._editorInputs.delete(inputKey);
		const instanceIndex = this.instances.findIndex(e => e === instance);
		if (instanceIndex !== -1) {
			this.instances.splice(instanceIndex, 1);
		}
		// Don't dispose the input when shutting down to avoid layouts in the editor area
		if (!this._isShuttingDown) {
			editorInput?.dispose();
		}
		const disposables = this._instanceDisposables.get(inputKey);
		this._instanceDisposables.delete(inputKey);
		if (disposables) {
			dispose(disposables);
		}
		this._onDidChangeInstances.fire();
	}

	resolveResource(resource: URI): TerminalEditorInput {
		const launchConfig = this._launchConfigs.get(resource.path);
		if (launchConfig) {
			const instance = this._terminalInstanceService.createInstance(launchConfig, launchConfig.target, resource);
			const input = this._instantiationService.createInstance(TerminalEditorInput, resource, instance);
			this._registerInstance(resource.path, input, instance);
			return input;
		} else {
			throw new Error('could not resolve resource');
		}
	}

	revealActiveEditor(preserveFocus?: boolean): void {
		const instance = this.activeInstance;
		if (!instance) {
			return;
		}

		const editorInput = this._editorInputs.get(instance.resource.path)!;
		this._editorService.openEditor(
			editorInput,
			{
				pinned: true,
				forceReload: true,
				preserveFocus,
				activation: EditorActivation.PRESERVE
			},
			editorInput.group
		);
	}
}
