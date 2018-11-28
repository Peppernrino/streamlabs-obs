import Vue from 'vue';
import { compose } from 'fp-ts/lib/function';
import { contramap, setoidString } from 'fp-ts/lib/Setoid';
import { uniq } from 'fp-ts/lib/Array';
import { Subject } from 'rxjs/Subject';
import uuid from 'uuid/v4';
import { without } from 'lodash';
import { mutation, StatefulService } from 'services/stateful-service';
import { TransitionsService } from 'services/transitions';
import { WindowsService } from 'services/windows';
import {
  IScene,
  ISceneCreateOptions,
  ISceneItem,
  IScenesServiceApi,
  IScenesState,
  Scene,
  SceneItem,
} from './index';
import { ISource, SourcesService } from 'services/sources';
import { Inject } from 'util/injector';
import * as obs from '../../../obs-api';
import { $t } from 'services/i18n';
import namingHelpers from 'util/NamingHelpers';

export class ScenesService extends StatefulService<IScenesState> implements IScenesServiceApi {
  static initialState: IScenesState = {
    activeSceneId: '',
    displayOrder: [],
    scenes: {},
  };

  sceneAdded = new Subject<IScene>();
  sceneRemoved = new Subject<IScene>();
  sceneSwitched = new Subject<IScene>();
  itemAdded = new Subject<ISceneItem & ISource>();
  itemRemoved = new Subject<ISceneItem & ISource>();
  itemUpdated = new Subject<ISceneItem & ISource>();

  @Inject() private windowsService: WindowsService;
  @Inject() private sourcesService: SourcesService;
  @Inject() private transitionsService: TransitionsService;

  @mutation()
  private ADD_SCENE(id: string, name: string) {
    Vue.set<IScene>(this.state.scenes, id, {
      id,
      name,
      resourceId: 'Scene' + JSON.stringify([id]),
      nodes: [],
    });
    this.state.displayOrder.push(id);
    this.state.activeSceneId = this.state.activeSceneId;
  }

  @mutation()
  private REMOVE_SCENE(id: string) {
    Vue.delete(this.state.scenes, id);

    this.state.displayOrder = without(this.state.displayOrder, id);
  }

  @mutation()
  private MAKE_SCENE_ACTIVE(id: string) {
    this.state.activeSceneId = id;
  }

  @mutation()
  private SET_SCENE_ORDER(order: string[]) {
    this.state.displayOrder = order;
  }

  createScene(name: string, options: ISceneCreateOptions = {}) {
    // Get an id to identify the scene on the frontend
    const id = options.sceneId || `scene_${uuid()}`;
    this.ADD_SCENE(id, name);
    const obsScene = obs.SceneFactory.create(id);
    this.sourcesService.addSource(obsScene.source, name, { sourceId: id });

    if (options.duplicateSourcesFromScene) {
      const oldScene = this.getScene(options.duplicateSourcesFromScene);
      const newScene = this.getScene(id);

      oldScene
        .getItems()
        .slice()
        .reverse()
        .forEach(item => {
          const newItem = newScene.addSource(item.sourceId);
          newItem.setSettings(item.getSettings());
        });
    }

    this.sceneAdded.next(this.state.scenes[id]);
    if (options.makeActive) this.makeSceneActive(id);
    return this.getScene(id);
  }

  removeScene(id: string, force = false): IScene {
    if (!force && Object.keys(this.state.scenes).length < 2) {
      return null;
    }

    const scene = this.getScene(id);
    const sceneModel = this.state.scenes[id];

    // remove all sources from scene
    scene.getItems().forEach(sceneItem => scene.removeItem(sceneItem.sceneItemId));

    // remove scene from other scenes if it has been added as a source
    this.getSceneItems().forEach(sceneItem => {
      if (sceneItem.sourceId !== scene.id) return;
      sceneItem.getScene().removeItem(sceneItem.sceneItemId);
    });

    this.REMOVE_SCENE(id);

    if (this.state.activeSceneId === id) {
      const sceneIds = Object.keys(this.state.scenes);

      if (sceneIds[0]) {
        this.makeSceneActive(sceneIds[0]);
      }
    }

    this.sceneRemoved.next(sceneModel);
    return sceneModel;
  }


  setLockOnAllScenes(locked: boolean) {
    this.scenes.forEach(scene => scene.setLockOnAllItems(locked));
  }


  getSourceScenes(sourceId: string): Scene[] {
    const resultScenes: Scene[] = [];
    this.scenes.forEach(scene => {
      const items = scene.getItems().filter(sceneItem => sceneItem.sourceId === sourceId);
      if (items.length > 0) resultScenes.push(scene);
    });
    return resultScenes;
  }


  makeSceneActive(id: string): boolean {
    const scene = this.getScene(id);
    if (!scene) return false;

    const activeScene = this.activeScene;

    this.transitionsService.transition(activeScene && activeScene.id, scene.id);

    this.MAKE_SCENE_ACTIVE(id);
    this.sceneSwitched.next(scene.getModel());
    return true;
  }

  setSceneOrder(order: string[]) {
    this.SET_SCENE_ORDER(order);
  }

  // Utility functions / getters

  getModel = (): IScenesState => this.state;

  getScene = (id: string) => (!this.state.scenes[id] ? null : new Scene(id));

  getSceneItem = (sceneItemId: string) => {
    for (const scene of this.scenes) {
      const sceneItem = scene.getItem(sceneItemId);
      if (sceneItem) return sceneItem;
    }
    return null;
  };

  getSceneItems = (): SceneItem[] => {
    const sceneItems: SceneItem[] = [];
    this.scenes.forEach(scene => sceneItems.push(...scene.getItems()));
    return sceneItems;
  };

  getScenes = (): Scene[] => this.scenes;

  get scenes(): Scene[] {
    const bySceneId = contramap((x: Scene) => x.id, setoidString);
    // prettier-ignore
    return compose(
      uniq(bySceneId),
      (ids: string[]) => ids.map(this.getScene)
    )(this.state.displayOrder);
  }

  get activeSceneId(): string {
    return this.state.activeSceneId;
  }

  get activeScene(): Scene {
    return this.getScene(this.state.activeSceneId);
  }

  suggestName(name: string): string {
    return namingHelpers.suggestName(name, (name: string) => {
      const ind = this.activeScene.getNodes().findIndex(node => node.name === name);
      return ind !== -1;
    });
  }

  showNameScene(options: { rename?: string; itemsToGroup?: string[] } = {}) {
    this.windowsService.showWindow({
      componentName: 'NameScene',
      title: options.rename ? $t('Rename Scene') : $t('Name Scene'),
      queryParams: options,
      size: {
        width: 400,
        height: 250,
      },
    });
  }

  showNameFolder(options: { renameId?: string; itemsToGroup?: string[]; parentId?: string } = {}) {
    this.windowsService.showWindow({
      componentName: 'NameFolder',
      title: options.renameId ? $t('Rename Folder') : $t('Name Folder'),
      queryParams: options,
      size: {
        width: 400,
        height: 250,
      },
    });
  }

  showDuplicateScene(sceneName: string) {
    this.windowsService.showWindow({
      componentName: 'NameScene',
      title: $t('Name Scene'),
      queryParams: { sceneToDuplicate: sceneName },
      size: {
        width: 400,
        height: 250,
      },
    });
  }
}
