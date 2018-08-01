import {
  Component,
  Input,
  Output,
  OnChanges,
  OnDestroy,
  EventEmitter,
  NgModule,
  ViewContainerRef,
  ComponentRef,
  ModuleWithComponentFactories,
  Type,
  SimpleChanges,
  NgModuleRef,
  NgModuleFactoryLoader,
  NgModuleFactory,
  Compiler,
  Injector,
  Renderer2,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { of } from 'rxjs';

import { Utils } from './dynamic.utils';
import { DynamicCache } from './dynamic.cache';
import {
  IDynamicRemoteTemplateFactory,
  IDynamicTemplateMetadata,
  IDynamicTemplatePlaceholder,
  IDynamicTemplateContext,
  AnyT,
  ILazyRoute,
  HASH_FIELD,
  IDynamicComponentConfig,
  DynamicHttpResponseT,
  IDynamicHttpRequest,
} from './dynamic.interface';
import { DynamicTemplateModuleHolder } from './dynamic.holder';

export class DynamicBase implements OnChanges, OnDestroy {

  @Output() templateReady: EventEmitter<IDynamicTemplatePlaceholder>;

  @Input() template: string;
  @Input() lazyModules: string[];
  @Input() httpUrl: string;
  @Input() context: IDynamicTemplateContext;
  @Input() remoteTemplateFactory: IDynamicRemoteTemplateFactory;
  @Input() extraModules: any[];
  @Input() styles: string[];
  @Input() defaultTemplate: string;

  private lazyExtraModules: Array<AnyT | (() => void)> = [];
  private injector: Injector;
  private dynamicSelector: string;
  private cachedDynamicModule: AnyT;
  private cachedTemplatePlaceholder: Type<IDynamicTemplatePlaceholder>;
  private templatePlaceholder: ComponentRef<IDynamicTemplatePlaceholder>;
  private moduleInstance: NgModuleRef<any>;
  private replacedNodes: Element[];

  constructor(protected dynamicExtraModules: any[],
              protected dynamicResponseRedirectStatuses: number[],
              protected viewContainer: ViewContainerRef,
              protected compiler: Compiler,
              protected http: HttpClient,
              protected renderer: Renderer2,
              protected dynamicCache: DynamicCache,
              protected moduleFactoryLoader: NgModuleFactoryLoader,
              protected routes: ILazyRoute[],
              protected removeDynamicWrapper: boolean,
              dynamicSelector: string) {
    this.templateReady = new EventEmitter<IDynamicTemplatePlaceholder>();
    this.dynamicSelector = Utils.buildByNextId(dynamicSelector);

    this.injector = Injector.create([], this.viewContainer.parentInjector);
  }

  /**
   * @override
   */
  public ngOnChanges(changes: SimpleChanges) {
    this.ngOnDestroy();

    this.buildModule().then((module) => {
        let compiledModulePromise;
        const currentModuleHash = Reflect.get(module, HASH_FIELD);

        if (Utils.isPresent(currentModuleHash)) {
          compiledModulePromise = this.dynamicCache.get(currentModuleHash);
          if (!Utils.isPresent(compiledModulePromise)) {
            this.dynamicCache.set(currentModuleHash, compiledModulePromise = this.compiler.compileModuleAndAllComponentsAsync<any>(module));
          }
        } else {
          compiledModulePromise = this.compiler.compileModuleAndAllComponentsAsync<any>(module);
        }

        compiledModulePromise
          .then((compiledModule) => this.makeDynamicTemplatePlaceholder(compiledModule));
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
    if (Utils.isPresent(this.templatePlaceholder)) {
      this.templatePlaceholder.destroy();
      this.templatePlaceholder = null;
    }
    if (Utils.isPresent(this.cachedDynamicModule)) {
      this.compiler.clearCacheFor(this.cachedDynamicModule);
      this.cachedDynamicModule = null;
    }
    if (Utils.isPresent(this.cachedTemplatePlaceholder)) {
      this.compiler.clearCacheFor(this.cachedTemplatePlaceholder);
      this.cachedTemplatePlaceholder = null;
    }
    if (Utils.isPresent(this.replacedNodes)) {
      for (const el of this.replacedNodes) {
        this.renderer.removeChild(el.parentElement, el);
      }
      this.replacedNodes = null;
    }
  }

  private makeDynamicTemplatePlaceholder(moduleWithComponentFactories: ModuleWithComponentFactories<any>) {
    this.moduleInstance = moduleWithComponentFactories.ngModuleFactory.create(this.injector);

    const factory = moduleWithComponentFactories.componentFactories.find((componentFactory) => (
      componentFactory.selector === this.dynamicSelector
      || (Utils.isPresent(componentFactory.componentType) && Utils.isPresent(this.template)
        && Reflect.get(componentFactory.componentType, HASH_FIELD) === Utils.toHash(this.template))
    ));

    const templatePlaceholder = this.templatePlaceholder = factory.create(this.injector, null, null, this.moduleInstance);
    this.viewContainer.insert(templatePlaceholder.hostView, 0);
    Utils.applySourceAttributes(this.templatePlaceholder.instance, this.context);

    if (this.removeDynamicWrapper) {
      this.replacedNodes = Utils.replaceDynamicContent(this.renderer, templatePlaceholder.location.nativeElement);
    }
    this.templateReady.emit(this.templatePlaceholder.instance);
  }

  private buildModule(): Promise<AnyT> {
    const lazyModules: string[] = [].concat(this.lazyModules || []);
    const lazyModulesLoaders: Array<Promise<NgModuleFactory<any> | (() => void)>> = [];

    for (const lazyModule of lazyModules) {
      const lazyRoute: ILazyRoute = Utils.findLazyRouteLoader(lazyModule, this.routes);
      if (lazyRoute) {
        if (Utils.isFunction(lazyRoute.loadChildren)) {
          // angular2-class starter
          lazyModulesLoaders.push(
            Observable.of((lazyRoute.loadChildren as (() => any))()).toPromise()
          );
        } else {
          // angular-cli
          lazyModulesLoaders.push(this.moduleFactoryLoader.load(lazyRoute.loadChildren as string));
        }
      } else {
        lazyModulesLoaders.push(this.moduleFactoryLoader.load(lazyModule));
      }
    }
    return new Promise((resolve: (value: AnyT) => void) => {
      Promise.all(lazyModulesLoaders)
        .then((moduleFactories: Array<NgModuleFactory<any> | (() => void)>) => {
          for (const moduleFactory of moduleFactories) {
            if (moduleFactory instanceof NgModuleFactory) {
              // angular-cli
              this.lazyExtraModules.push(moduleFactory.moduleType);
            } else {
              // angular2-class starter
              this.lazyExtraModules.push(moduleFactory);
            }
          }
          if (Utils.isPresent(this.template)) {
            resolve(this.makeComponentModule({ template: this.template }));
          } else if (Utils.isPresent(this.httpUrl)) {
            this.loadRemoteTemplate(this.httpUrl, resolve);
          } else {
            resolve(this.makeComponentModule());
          }
        });
    });
  }

  private loadRemoteTemplate(httpUrl: string, resolve: (value: AnyT) => void) {
    let requestArgs: IDynamicHttpRequest;
    if (Utils.isPresent(this.remoteTemplateFactory)
      && Utils.isFunction(this.remoteTemplateFactory.buildRequestOptions)) {
      requestArgs = this.remoteTemplateFactory.buildRequestOptions();
    }

    this.http.get(httpUrl, { withCredentials: true, observe: 'response', ...requestArgs } )
      .subscribe((response: DynamicHttpResponseT) => {
        if (this.dynamicResponseRedirectStatuses.includes(response.status)) {
          const chainedUrl = response.headers.get('Location');
          if (Utils.isPresent(chainedUrl)) {
            this.loadRemoteTemplate(chainedUrl, resolve);
          } else {
            console.warn(`The location header is empty. Stop processing. Response status is ${response.status}`);
          }
        } else {
          resolve(
            this.makeComponentModule({ template: Utils.toTemplate(this.remoteTemplateFactory, response) })
          );
        }
      }, () => {
        const template = this.defaultTemplate || '';
        resolve(this.makeComponentModule({ template }));
      });
  }

  private makeComponentModule(dynamicConfig?: IDynamicComponentConfig): AnyT {
    const dynamicComponentCtor = this.cachedTemplatePlaceholder = this.makeComponent(dynamicConfig);

    const modules = this.dynamicExtraModules
      .concat(this.extraModules || [])
      .concat(this.lazyExtraModules)
      .concat(DynamicTemplateModuleHolder.saveAndGet());

    @NgModule({
      declarations: [dynamicComponentCtor],
      imports: [CommonModule].concat(modules),
    })
    class $DynamicComponentModule {
    }

    Utils.applyHashField($DynamicComponentModule, dynamicComponentCtor);
    return this.cachedDynamicModule = $DynamicComponentModule;
  }

  private makeComponent(componentConfig?: IDynamicComponentConfig): Type<IDynamicTemplatePlaceholder> {
    const dynamicComponentMetaData: IDynamicTemplateMetadata = {
      selector: this.dynamicSelector,
      styles: this.styles,
    };

    if (Utils.isPresent(componentConfig)) {
      if (Utils.isPresent(componentConfig.template)) {
        dynamicComponentMetaData.template = componentConfig.template;
      } else if (Utils.isPresent(componentConfig.templatePath)) {
        dynamicComponentMetaData.templateUrl = componentConfig.templatePath;
      }
    }

    @Component(dynamicComponentMetaData)
    class $DynamicComponent {
    }

    Utils.applyHashField($DynamicComponent, dynamicComponentMetaData.template);
    return $DynamicComponent;
  }
}
