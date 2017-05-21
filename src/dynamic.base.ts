import {
	Component,
	Input,
	Output,
	Compiler,
	OnChanges,
	OnDestroy,
	EventEmitter,
	NgModule,
	ViewContainerRef,
	ComponentRef,
	ModuleWithComponentFactories,
	ComponentFactory,
	Type,
	ReflectiveInjector,
	SimpleChanges,
	NgModuleRef,
	NgModuleFactoryLoader,
	NgModuleFactory
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { Http, Response, RequestOptionsArgs } from '@angular/http';
import { Utils } from './Utils';
import { DynamicCache } from './dynamic.cache';
import {
	IComponentRemoteTemplateFactory, IDynamicMetadata, IDynamicType, IDynamicTemplateContext
} from './dynamic.interface';

export interface DynamicComponentConfig {
	template?: string;
	templatePath?: string;
}

export type AnyT = Type<any>;

const HASH_FIELD:string = '__hashValue';

export class DynamicBase implements OnChanges, OnDestroy {

	@Output() templateReady: EventEmitter<IDynamicType>;
	@Output() templateBeforeReady: EventEmitter<void>;

	@Input() template: string;
	@Input() lazyModules: string[];
	@Input() context: IDynamicTemplateContext;
	@Input() componentStyles: string[];
	@Input() componentTemplateUrl: string;
	@Input() componentTemplatePath: string;
	@Input() componentDefaultTemplate: string;
	@Input() componentRemoteTemplateFactory: IComponentRemoteTemplateFactory;
	@Input() componentModules: Array<any>;

	private lazyExtraModules: Type<any>[] = [];
	private injector:ReflectiveInjector;
	private dynamicSelector:string;
	private cachedDynamicModule:AnyT;
	private cachedDynamicComponent:Type<IDynamicType>;
	private componentInstance: ComponentRef<IDynamicType>;
	private moduleInstance: NgModuleRef<any>;

	constructor(protected dynamicExtraModules: Array<any>,
	            protected viewContainer: ViewContainerRef,
	            protected compiler: Compiler,
	            protected http: Http,
	            protected dynamicCache: DynamicCache,
	            protected moduleFactoryLoader: NgModuleFactoryLoader,
	            dynamicSelector: string) {
		this.templateReady = new EventEmitter<IDynamicType>();
		this.templateBeforeReady = new EventEmitter<void>();
		this.dynamicSelector = Utils.buildByNextId(dynamicSelector);

		this.injector = ReflectiveInjector.fromResolvedProviders([], this.viewContainer.parentInjector);
	}

	/**
	 * @override
	 */
	public ngOnChanges(changes: SimpleChanges) {
		this.ngOnDestroy();
		this.templateBeforeReady.emit(null);

		// TODO investigate memory leak in the specific case
		this.buildModule().then((module: AnyT) => {
				let compiledModule: Promise<ModuleWithComponentFactories<any>>;
				const currentModuleHash: string = Reflect.get(module, HASH_FIELD);

				if (Utils.isPresent(currentModuleHash)) {
					compiledModule = this.dynamicCache.get(currentModuleHash);
					if (!Utils.isPresent(compiledModule)) {
						this.dynamicCache.set(currentModuleHash, compiledModule = this.compiler.compileModuleAndAllComponentsAsync<any>(module));
					}
				} else {
					compiledModule = this.compiler.compileModuleAndAllComponentsAsync<any>(module);
				}

				compiledModule
					.then((compiledModule: ModuleWithComponentFactories<any>) => this.makeDynamicComponent(compiledModule))
			}
		);
	}

	/**
	 * @override
	 */
	public ngOnDestroy() {
		if (Utils.isPresent(this.moduleInstance)) {
			this.moduleInstance.destroy();
			this.moduleInstance = null;
		}
		if (Utils.isPresent(this.componentInstance)) {
			this.componentInstance.destroy();
			this.componentInstance = null;
		}
		if (Utils.isPresent(this.cachedDynamicModule)) {
			this.compiler.clearCacheFor(this.cachedDynamicModule);
			this.cachedDynamicModule = null;
		}
		if (Utils.isPresent(this.cachedDynamicComponent)) {
			this.compiler.clearCacheFor(this.cachedDynamicComponent);
			this.cachedDynamicComponent = null;
		}
	}

	private makeDynamicComponent(moduleWithComponentFactories: ModuleWithComponentFactories<any>) {
		this.moduleInstance = moduleWithComponentFactories.ngModuleFactory.create(this.injector);

		const factory = moduleWithComponentFactories.componentFactories.find((componentFactory: ComponentFactory<AnyT>) => {
				return componentFactory.selector === this.dynamicSelector
					|| (Utils.isPresent(componentFactory.componentType) && Utils.isPresent(this.template)
					&& Reflect.get(componentFactory.componentType, HASH_FIELD) === Utils.hashFnv32a(this.template, true));
			}
		);

		const componentInstance = this.componentInstance = factory.create(this.injector, null, null, this.moduleInstance);
		this.viewContainer.insert(componentInstance.hostView, 0);

		this.applyPropertiesToDynamicComponent(this.componentInstance.instance);
		this.templateReady.emit(this.componentInstance.instance);
	}

	private buildModule(): Promise<AnyT> {
		const lazyModules: string[] = [].concat(this.lazyModules || []);
		const lazyModulesLoaders: Promise<NgModuleFactory<any>>[] = [];

		for (let lazyModule of lazyModules) {
			lazyModulesLoaders.push(this.moduleFactoryLoader.load(lazyModule));
		}
		return new Promise((resolve: (value: AnyT) => void) => {
			Promise.all(lazyModulesLoaders)
				.then((moduleFactories: NgModuleFactory<any>[]) => {
					for (let moduleFactory of moduleFactories) {
						this.lazyExtraModules.push(moduleFactory.moduleType);
					}

					if (Utils.isPresent(this.template)) {
						resolve(this.makeComponentModule({template: this.template}));
					} else if (Utils.isPresent(this.componentTemplatePath)) {
						resolve(this.makeComponentModule({templatePath: this.componentTemplatePath}));
					} else if (Utils.isPresent(this.componentTemplateUrl)) {
						this.loadRemoteTemplate(this.componentTemplateUrl, resolve);
					} else {
						resolve(this.makeComponentModule());
					}
				});
		});
	}

	private loadRemoteTemplate(url: string, resolve: (value: AnyT) => void) {
		let requestArgs: RequestOptionsArgs = {withCredentials: true};
		if (Utils.isPresent(this.componentRemoteTemplateFactory)) {
			requestArgs = this.componentRemoteTemplateFactory.buildRequestOptions();
		}

		this.http.get(url, requestArgs)
			.subscribe((response: Response) => {
				// TODO Inject response statuses
				if ([301, 302, 307, 308].indexOf(response.status) > -1) {
					const chainedUrl: string = response.headers.get('Location');
					if (Utils.isPresent(chainedUrl)) {
						this.loadRemoteTemplate(chainedUrl, resolve);
					}
				} else {
					const loadedTemplate: string = Utils.isPresent(this.componentRemoteTemplateFactory)
						? this.componentRemoteTemplateFactory.parseResponse(response)
						: response.text();

					resolve(this.makeComponentModule({template: loadedTemplate}));
				}
			}, (response: Response) => {
				const template: string = this.componentDefaultTemplate || '';
				resolve(this.makeComponentModule({template: template}));
			});
	}

	private makeComponentModule(dynamicConfig?: DynamicComponentConfig): AnyT {
		const dynamicComponentType: Type<IDynamicType>
			= this.cachedDynamicComponent
			= this.makeComponent(dynamicConfig);

		const componentModules: Array<any> = this.dynamicExtraModules
			.concat(this.componentModules || [])
			.concat(this.lazyExtraModules);

		@NgModule({
			declarations: [dynamicComponentType],
			imports: [CommonModule].concat(componentModules)
		})
		class dynamicComponentModule {
		}

		const dynamicComponentTypeHash: string = Reflect.get(dynamicComponentType, HASH_FIELD);
		if (Utils.isPresent(dynamicComponentTypeHash)) {
			Reflect.set(dynamicComponentModule, HASH_FIELD, dynamicComponentTypeHash);
		}
		return this.cachedDynamicModule = dynamicComponentModule;
	}

	private makeComponent(componentConfig?: DynamicComponentConfig): Type<IDynamicType> {
		const dynamicComponentMetaData: IDynamicMetadata = {
			selector: this.dynamicSelector,
			styles: this.componentStyles
		};

		if (Utils.isPresent(componentConfig)) {
			if (Utils.isPresent(componentConfig.template)) {
				dynamicComponentMetaData.template = componentConfig.template;
			} else if (Utils.isPresent(componentConfig.templatePath)) {
				dynamicComponentMetaData.templateUrl = componentConfig.templatePath;
			}
		}

		@Component(dynamicComponentMetaData)
		class dynamicComponentClass {
		}

		if (Utils.isPresent(Reflect.get(dynamicComponentMetaData, 'template'))) {
			Reflect.set(dynamicComponentClass, HASH_FIELD, Utils.hashFnv32a(Reflect.get(dynamicComponentMetaData, 'template'), true));
		}
		return dynamicComponentClass as Type<IDynamicType>;
	}

	private applyPropertiesToDynamicComponent(instance: IDynamicType) {
		if (!Utils.isPresent(this.context)) {
			return;
		}

		for (let property in this.context) {
			const propValue = Reflect.get(this.context, property);
			const attributes: PropertyDescriptor = {} as PropertyDescriptor;

			if (!Utils.isFunction(propValue)) {
				attributes.set = (v) => Reflect.set(this.context, property, v);
			}
			attributes.get = () => Reflect.get(this.context, property);

			Reflect.defineProperty(instance, property, attributes);
		}
	}
}
