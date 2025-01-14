// Synces maps data to Webflow collection.

import { writeFileSync, readFileSync } from 'node:fs';
import util from 'util';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import got from 'got';
import { WebflowClient } from 'webflow-api';
import type * as Webflow from 'webflow-api/api/types';
import Bottleneck from 'bottleneck';
import { program } from '@commander-js/extra-typings';
import { readMapList, fetchMapsMetadata } from './maps_metadata.js';
import { MapList } from '../../../gen/types/map_list.js';
import { readMapCDNInfos } from './cdn_maps.js';
import { MapCDNInfo } from '../../../gen/types/cdn_maps.js';
import mapSchema from '../../../gen/schemas/map_list.json';
import {
    WebflowImageRef,
    WebflowMapFieldsRead,
    WebflowMapFieldsWrite,
    WebflowMapTagFieldsRead,
    WebflowMapTagFieldsWrite,
    WebflowMapTerrainFieldsRead,
    WebflowMapTerrainFieldsWrite,
} from './webflow_types.js';
import assert from 'node:assert';
import pLimit, { LimitFunction } from 'p-limit';
import { getDerivedInfo } from './derived_map_info.js';

const mapsCacheDir = process.env.MAPS_CACHE_DIR || '.maps-cache'

// ImageHashesCache is a cache from url to image hash so we don't
// to download the image to get the hash.
class ImageHashesCache {
    private readonly limit: LimitFunction;
    private newHashes: number = 0;
    private readonly cachePath: string;
    private static readonly imageHashesCacheVersion: number = 1;
    private readonly imageHashesCache: Map<string, string>;

    constructor(cachePath: string) {
        this.limit = pLimit(20);
        this.cachePath = cachePath;
        this.imageHashesCache = new Map();

        process.on('beforeExit', () => this.saveImageHashesCacheSync());
        try {
            const c = JSON.parse(readFileSync(
                this.cachePath, { encoding: 'utf8' }));
            if (c.version == ImageHashesCache.imageHashesCacheVersion) {
                this.imageHashesCache = new Map(c.entries);
            }
        } catch (e) {
            console.warn(`Warning: ${e}`);
        }
    }

    saveImageHashesCacheSync() {
        try {
            writeFileSync(
                this.cachePath,
                JSON.stringify({
                    version: ImageHashesCache.imageHashesCacheVersion,
                    entries: [...this.imageHashesCache]
                }));
        } catch (e) {
            console.warn(`Warning: ${e}`);
        }
    }

    // getImageHash returns the hash of the image at the given url.
    async getImageHash(url: string | null): Promise<string> {
        if (!url) {  // Handles both null and '';
            return '';
        }
        if (this.imageHashesCache.has(url)) {
            return this.imageHashesCache.get(url)!;
        }
        const hash = createHash('sha256');
        await this.limit(() => pipeline(got.stream(url), hash));
        const digest = hash.digest('hex');
        console.log(`Hashed ${url} to ${digest}`);
        this.imageHashesCache.set(url, digest);

        if (++this.newHashes > 30) {
            this.saveImageHashesCacheSync();
            this.newHashes = 0;
        }
        return digest;
    }
}

const imageHashesCache = new ImageHashesCache(path.join(mapsCacheDir, 'imageHashesCache.json'));

const getImageHash = (url: string | null) => imageHashesCache.getImageHash(url);

// Helpers to not make mistakes when converting from webflow Read types to internal type.
function reqR<T>(n: T | undefined, def: T): T {
    return n === undefined ? def : n;
}

function optR<T>(n: T | undefined): T | null {
    return n === undefined ? null : n;
}

function reqRNum(n: number | undefined): number {
    return reqR(n, -1);
}

function reqRStr(n: string | undefined): string {
    return reqR(n, '');
}

function reqRArr<T>(n: T[] | undefined): T[] {
    return reqR(n, []);
}

async function sameImage(url1: string | null, url2: string | null): Promise<boolean> {
    const [h1, h2] = await Promise.all([getImageHash(url1), getImageHash(url2)]);
    return h1 === h2;
}

async function sameImages(urls1: string[], urls2: string[]): Promise<boolean> {
    const [h1, h2] = await Promise.all([
        Promise.all(urls1.map(getImageHash)),
        Promise.all(urls2.map(getImageHash))
    ]);
    if (urls1.length !== urls2.length) {
        return false;
    }
    h1.sort();
    h2.sort();
    return h1.every((v, i) => v === h2[i]);
}

async function pickImage(url: string, base?: WebflowImageRef): Promise<string> {
    if (base && await sameImage(url, base.url)) {
        return base.fileId;
    }
    return url;
}

async function pickImages(urls: string[], base?: WebflowImageRef[]): Promise<string[]> {
    const [h, hBaseEntries] = await Promise.all([
        Promise.all(urls.map(async url => {
            return [url, await getImageHash(url)] as [string, string];
        })),
        Promise.all((base || []).map(async i => {
            return [await getImageHash(i.url), i.fileId] as [string, string];
        }))
    ]);
    const hBase = new Map(hBaseEntries);
    return h.map(([url, hash]) => {
        const baseFileId = hBase.get(hash);
        if (baseFileId) {
            return baseFileId;
        }
        return url;
    });
}

function isSameRefs(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function slugFromName(name: string): string {
    return name.toLowerCase().replace(/[. _]/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * There are 3 layers of data mapping in this script:
 * 1. Source of data in the format of MapList as used in this repository
 *    and ammended with cdn info etc.
 * 2. Native Webflow represention of data as used by the Webflow API.
 * 3. Internal WebsiteMapInfo representation of data in this script which
 *    is used to bridge the gap between 1 and 2.
 *
 * We use the internal representation because both the source and the
 * Webflow API have different ways of representing the same data with
 * webflow e.g. requiring a two fiels for a photo: one for actual image
 * and second for a url to the image. It also gives us a more strongly
 * typed interface to work with for comparison.
 */


interface IWebsiteItem {
    name: string;
    slug: string;
}

interface IWebflowItemType {
    new(i: Webflow.CollectionItem): IWebflowItem
    generateFields(i: IWebsiteItem): Webflow.CollectionItemFieldData;
}

function fieldsToItem(fields: Webflow.CollectionItemFieldData): Webflow.CollectionItem {
    // Need to cast because no id, that's because of
    // https://github.com/webflow/openapi-spec/issues/4
    return {
        isDraft: false,
        isArchived: false,
        fieldData: fields
    } as Webflow.CollectionItem;
}

interface IWebflowItem extends IWebsiteItem {
    item: Webflow.CollectionItem;
}

// WebsiteMapTag is the internal representation of a map tag used in this script.
interface WebsiteMapTag extends IWebsiteItem { }

function isWebsiteMapTagEqual(a: WebsiteMapTag, b: WebsiteMapTag): boolean {
    return a.name === b.name && a.slug === b.slug;
}

interface WebflowMapTag extends WebsiteMapTag { }

// WebflowMapTag is the native Webflow representation of a tag as used by the
// Webflow API.
class WebflowMapTag implements IWebflowItem {
    item: Webflow.CollectionItem;

    constructor(item: Webflow.CollectionItem) {
        this.item = item;
        const o = item.fieldData as WebflowMapTagFieldsRead;

        this.name = o.name;
        this.slug = o.slug;
    }

    static generateFields(tag: WebsiteMapTag): WebflowMapTagFieldsWrite {
        return {
            name: tag.name,
            slug: tag.slug,
        };
    }
}

// WebsiteMapTerrain is the internal representation of a map Terrain used in this script.
interface WebsiteMapTerrain extends IWebsiteItem { }

function isWebsiteMapTerrainEqual(a: WebsiteMapTerrain, b: WebsiteMapTerrain): boolean {
    return a.name === b.name && a.slug === b.slug;
}

interface WebflowMapTerrain extends WebsiteMapTerrain { }

// WebflowMapTerrain is the native Webflow representation of a Terrain as used by the
// Webflow API.
class WebflowMapTerrain implements IWebflowItem {
    item: Webflow.CollectionItem;

    constructor(item: Webflow.CollectionItem) {
        this.item = item;
        const o = item.fieldData as WebflowMapTerrainFieldsRead;

        this.name = o.name;
        this.slug = o.slug;
    }

    static generateFields(terrain: WebsiteMapTerrain): WebflowMapTerrainFieldsWrite {
        return {
            name: terrain.name,
            slug: terrain.slug,
        };
    }
}

// WebsiteMapInfo is the internal representation of data used in this script.
// it is the most thruthful representation of data as we want it to be in
// webflow.
interface WebsiteMapInfo {
    name: string;
    rowyId: string;
    minimapUrl: string;
    minimapThumbUrl: string;
    downloadUrl: string;
    width: number;
    height: number;
    mapSize: number;
    title: string | null;
    description: string | null;
    author: string;
    bgImageUrl: string | null;
    perspectiveShotUrl: string | null;
    moreImagesUrl: string[];
    windMin: number;
    windMax: number;
    tidalStrength: number | null;
    teamCount: number;
    maxPlayers: number;
    textureMapUrl: string;
    heightMapUrl: string;
    metalMapUrl: string;
    mapTags: string[];
    mapTerrains: string[];
}

async function isWebflowMapInfoEqual(a: WebsiteMapInfo, b: WebsiteMapInfo): Promise<boolean> {
    const allImagesSame = (await Promise.all([
        sameImage(a.minimapUrl, b.minimapUrl),
        sameImage(a.minimapThumbUrl, b.minimapThumbUrl),
        sameImage(a.bgImageUrl, b.bgImageUrl),
        sameImage(a.perspectiveShotUrl, b.perspectiveShotUrl),
        sameImages(a.moreImagesUrl, b.moreImagesUrl),
        sameImage(a.textureMapUrl, b.textureMapUrl),
        sameImage(a.heightMapUrl, b.heightMapUrl),
        sameImage(a.metalMapUrl, b.metalMapUrl)
    ])).every(x => x);

    return allImagesSame &&
        a.name === b.name &&
        a.rowyId === b.rowyId &&
        a.downloadUrl === b.downloadUrl &&
        a.width === b.width &&
        a.height === b.height &&
        a.mapSize === b.mapSize &&
        a.title === b.title &&
        a.description === b.description &&
        a.author === b.author &&
        a.windMin === b.windMin &&
        a.windMax === b.windMax &&
        a.tidalStrength === b.tidalStrength &&
        a.teamCount === b.teamCount &&
        a.maxPlayers === b.maxPlayers &&
        isSameRefs(a.mapTags, b.mapTags) &&
        isSameRefs(a.mapTerrains, b.mapTerrains);
}

interface WebflowMapInfo extends WebsiteMapInfo { }

// fieldData is marked as possibly not set for some reason.
type CollectionItemWithData = Webflow.CollectionItem & { fieldData: Webflow.CollectionItemFieldData };

// WebflowMap is the native Webflow representation of data as used by the
// Webflow API.
class WebflowMapInfo {
    // fieldData is always set.
    item: CollectionItemWithData;

    constructor(item: Webflow.CollectionItem) {
        assert(item.fieldData);
        this.item = item as CollectionItemWithData;
        const o = item.fieldData as WebflowMapFieldsRead;

        this.name = o.name;
        this.rowyId = reqRStr(o.rowyid);
        this.minimapUrl = reqRStr(o.minimap?.url);
        this.minimapThumbUrl = reqRStr(o['minimap-photo-thumb']?.url);
        this.downloadUrl = reqRStr(o.downloadurl);
        this.width = reqRNum(o.width);
        this.height = reqRNum(o.height);
        this.mapSize = reqRNum(o.mapsize);
        this.title = optR(o.title);
        this.description = optR(o.description);
        this.author = reqRStr(o.author);
        this.bgImageUrl = optR(o['bg-image']?.url);
        this.perspectiveShotUrl = optR(o['perspective-shot']?.url);
        this.moreImagesUrl = reqRArr(o['more-images']?.map(i => i.url));
        this.windMin = reqRNum(o['wind-min']);
        this.windMax = reqRNum(o['wind-max']);
        this.tidalStrength = optR(o['tidal-strength']);
        this.teamCount = reqRNum(o['team-count']);
        this.maxPlayers = reqRNum(o['max-players']);
        this.textureMapUrl = reqRStr(o['mini-map']?.url);
        this.heightMapUrl = reqRStr(o['height-map']?.url);
        this.metalMapUrl = reqRStr(o['metal-map']?.url);
        this.mapTags = reqRArr(o['game-tags-ref-2']);
        this.mapTerrains = reqRArr(o['terrain-types']);
    }

    static async generateFields(info: WebsiteMapInfo, base?: WebflowMapInfo): Promise<WebflowMapFieldsWrite> {
        return {
            name: info.name,
            slug: slugFromName(info.name),
            rowyid: info.rowyId,
            minimap: await pickImage(info.minimapUrl, base?.item.fieldData.minimap),
            'minimap-photo-thumb': await pickImage(info.minimapThumbUrl, base?.item.fieldData['minimap-photo-thumb']),
            downloadurl: info.downloadUrl,
            width: info.width,
            height: info.height,
            mapsize: info.mapSize,
            title: info.title,
            description: info.description,
            author: info.author,
            'bg-image': info.bgImageUrl ? await pickImage(info.bgImageUrl, base?.item.fieldData['bg-image']) : null,
            'perspective-shot': info.perspectiveShotUrl ? await pickImage(info.perspectiveShotUrl, base?.item.fieldData['perspective-shot']) : null,
            'more-images': await pickImages(info.moreImagesUrl, base?.item.fieldData['more-images']),
            'wind-min': info.windMin,
            'wind-max': info.windMax,
            'tidal-strength': info.tidalStrength,
            'team-count': info.teamCount,
            'max-players': info.maxPlayers,
            'mini-map': await pickImage(info.textureMapUrl, base?.item.fieldData['mini-map']),
            'height-map': await pickImage(info.heightMapUrl, base?.item.fieldData['height-map']),
            'metal-map': await pickImage(info.metalMapUrl, base?.item.fieldData['metal-map']),
            'game-tags-ref-2': info.mapTags,
            'terrain-types': info.mapTerrains,
        };
    }
}

// buildWebflowInfo builds the WebflowMapInfo from Rowy data keyed by rowyId.
async function buildWebflowInfo(
    maps: MapList,
    cdnInfo: Map<string, MapCDNInfo>,
    mapsMetadata: Map<string, any>
): Promise<[Map<string, WebsiteMapInfo>, Map<string, WebsiteMapTag>]> {
    const imagorUrlBase = 'https://maps-metadata.beyondallreason.dev/i/';
    const rowyBucket = 'rowy-1f075.appspot.com';

    const mapInfo: Map<string, WebsiteMapInfo> = new Map();
    const allMapTags: Map<string, WebsiteMapTag> = new Map();

    for (const [rowyId, map] of Object.entries(maps)) {
        const mi = cdnInfo.get(map.springName);
        if (!mi) {
            throw new Error(`Missing download url for ${map.springName}`);
        }

        const meta = mapsMetadata.get(rowyId);
        // Just in case cache version changed or something.
        for (const img of ['height.png', 'metal.png', 'texture.jpg']) {
            assert(meta.extractedFiles.includes(img));
        }

        const derivedInfo = getDerivedInfo(map, meta);

        for (const tag of derivedInfo.tags) {
            const slug = slugFromName(tag);
            allMapTags.set(slug, { name: tag.toUpperCase(), slug });
        }

        const info: WebsiteMapInfo = {
            name: map.displayName,
            rowyId,
            minimapUrl: `${imagorUrlBase}fit-in/1024x1024/filters:format(webp):quality(85)/${rowyBucket}/${encodeURI(map.photo[0].ref)}`,
            minimapThumbUrl: `${imagorUrlBase}fit-in/640x640/filters:format(webp):quality(85)/${rowyBucket}/${encodeURI(map.photo[0].ref)}`,
            downloadUrl: mi.mirrors[0],
            width: derivedInfo.width,
            height: derivedInfo.height,
            mapSize: derivedInfo.width * derivedInfo.height,
            title: map.title || null,
            description: map.description || null,
            author: map.author,
            bgImageUrl: (map.backgroundImage.length > 0 ? `${imagorUrlBase}fit-in/2250x/filters:format(webp):quality(85)/${rowyBucket}/${encodeURI(map.backgroundImage[0]!.ref)}` : null),
            perspectiveShotUrl: (map.perspectiveShot.length > 0 ? `${imagorUrlBase}fit-in/2250x/filters:format(webp):quality(85)/${rowyBucket}/${encodeURI(map.perspectiveShot[0]!.ref)}` : null),
            moreImagesUrl: map.inGameShots.map(i => `${imagorUrlBase}fit-in/2250x/filters:format(webp):quality(85)/${rowyBucket}/${encodeURI(i.ref)}`),
            // Defaults from spring/cont/base/maphelper/maphelper/mapdefaults.lua
            windMin: derivedInfo.windMin,
            windMax: derivedInfo.windMax,
            tidalStrength: derivedInfo.tidalStrength ?? null,
            teamCount: map.teamCount,
            maxPlayers: map.playerCount,
            textureMapUrl: `${imagorUrlBase}fit-in/1024x1024/filters:format(webp):quality(85)/${meta.location.bucket}/${encodeURI(meta.location.path + '/texture.jpg')}`,
            heightMapUrl: `${imagorUrlBase}fit-in/1024x1024/filters:format(webp):quality(85)/${meta.location.bucket}/${encodeURI(meta.location.path + '/height.png')}`,
            metalMapUrl: `${imagorUrlBase}fit-in/1024x1024/filters:format(png)/${meta.location.bucket}/${encodeURI(meta.location.path + '/metal.png')}`,
            mapTags: derivedInfo.tags,
            mapTerrains: derivedInfo.terrainOrdered,
        };

        // Sanity check because the metadata stuff is using `any` type.
        for (const [k, v] of Object.entries(info)) {
            if (v === undefined || v === '') {
                throw new Error(`Missing value for map ${map.springName} key ${k}`);
            }
        }

        mapInfo.set(rowyId, info);
    }
    return [mapInfo, allMapTags];
}

async function getFieldCollection(field: keyof WebflowMapFieldsRead, mapCollection: Webflow.Collection, webflow: WebflowClient): Promise<Webflow.Collection> {
    // We have to do this because WebFlow OpenAPI Spec is incomplete
    // https://github.com/webflow/openapi-spec/issues/3
    type RealWebFlowCollectionField = Webflow.Field & { validations: any };
    const fields = mapCollection.fields.filter(f => f.slug === field) as RealWebFlowCollectionField[];
    if (fields.length !== 1) {
        throw new Error(`Expected one field with slug '${field}' in ${mapCollection.slug}, got ${fields.length}`);
    }
    return await webflow.collections.get(fields[0].validations!.collectionId);
}


function resolveItemRefsInMapInfos(mapInfos: Map<string, WebsiteMapInfo>, field: 'mapTags' | 'mapTerrains', refs: Map<string, IWebflowItem>, dryRun: boolean) {
    for (const mapInfo of mapInfos.values()) {
        mapInfo[field] = mapInfo[field].map(ref => {
            const t = refs.get(ref);
            if (!t) {
                if (dryRun) {
                    return ref;
                }
                throw new Error(`Missing ${field} ${ref}`);
            }
            return t.item.id;
        });
    }
}

async function getAllWebflowItems(collection: Webflow.Collection): Promise<Webflow.CollectionItem[]> {
    const items: Webflow.CollectionItem[] = [];
    const limit = 100;
    for (let offset = 0; true; offset += limit) {
        const response = await limiter.schedule(() => webflow.collections.items.listItems(collection.id, { limit, offset }));
        if (!response.items || response.items.length === 0) {
            break;
        }
        items.push(...response.items);
    }
    return items;
}

// getAllWebflowMaps returns all maps from the Webflow collection mapped by rowyId.
async function getAllWebflowMaps(mapsCollection: Webflow.Collection): Promise<Map<string, WebflowMapInfo>> {
    const items = await getAllWebflowItems(mapsCollection);
    const maps = items.map(item => new WebflowMapInfo(item));
    const res = new Map();
    let dupId = 0;
    for (const map of maps) {
        if (res.has(map.rowyId)) {
            console.warn(`Warning: Duplicate rowyId ${map.rowyId}, duplicating with fake.`);
            map.rowyId = `${map.rowyId}-bad${dupId++}`;
        }
        res.set(map.rowyId, map);
    }
    return res;
}

// getAllWebflowMapTags returns all map tags from the Webflow collection mapped by map tag slug.
async function getAllWebflowMapTags(mapTagsCollection: Webflow.Collection): Promise<Map<string, WebflowMapTag>> {
    const items = await getAllWebflowItems(mapTagsCollection);
    const tags = items.map(item => new WebflowMapTag(item));
    return new Map(tags.map(tag => [tag.slug, tag]));
}

// getAllWebflowMapTerrains returns all map tags from the Webflow collection mapped by map tag slug.
async function getAllWebflowMapTerrains(mapTagsCollection: Webflow.Collection): Promise<Map<string, WebflowMapTerrain>> {
    const items = await getAllWebflowItems(mapTagsCollection);
    const terrains = items.map(item => new WebflowMapTerrain(item));
    return new Map(terrains.map(t => [t.slug, t]));
}

async function syncCollectionToWebflowAdditions(
    webflowItemType: IWebflowItemType,
    equals: (a: IWebsiteItem, b: IWebflowItem) => boolean,
    typeName: string,
    src: Map<string, IWebsiteItem>,
    dest: Map<string, IWebflowItem>,
    collection: Webflow.Collection,
    dryRun: boolean,
) {
    for (const item of src.values()) {
        const webflowTag = dest.get(item.slug);
        if (!webflowTag) {
            const fields = webflowItemType.generateFields(item);
            console.log(`Adding ${typeName} ${item.name}`);
            if (!dryRun) {
                const item = await limiter.schedule(
                    () => webflow.collections.items.createItem(
                        collection.id, fieldsToItem(fields)));
                assert(item.fieldData!.slug!);
                dest.set(item.fieldData!.slug!, new webflowItemType(item));
            } else {
                console.log(fields);
            }
        } else if (!equals(item, webflowTag)) {
            console.log(`Updating ${typeName} ${item.name}`);
            const fields = webflowItemType.generateFields(item);
            if (!dryRun) {
                const itemPatch = fieldsToItem(fields);
                itemPatch.id = webflowTag.item.id;
                const item = await limiter.schedule(
                    () => webflow.collections.items.updateItem(
                        collection.id, webflowTag.item.id, itemPatch));
                assert(item.fieldData!.slug!);
                dest.set(item.fieldData!.slug!, new webflowItemType(item));
            } else {
                console.log(webflowTag);
                console.log(fields);
            }
        }
    }
}

async function syncCollectionToWebflowRemovals(
    collection: Webflow.Collection,
    typeName: string,
    src: Map<string, IWebsiteItem>,
    dest: Map<string, IWebflowItem>,
    dryRun: boolean,
) {
    for (const item of dest.values()) {
        if (!src.has(item.slug)) {
            console.log(`Removing ${typeName} ${item.name}`);
            if (!dryRun) {
                await limiter.schedule(() => webflow.collections.items.deleteItem(collection.id, item.item.id));
                dest.delete(item.slug);
            }
        }
    }
}

async function syncMapTagsToWebflowAdditions(
    src: Map<string, WebsiteMapTag>,
    dest: Map<string, WebflowMapTag>,
    mapTagsCollection: Webflow.Collection,
    dryRun: boolean
) {
    return syncCollectionToWebflowAdditions(WebflowMapTag, isWebsiteMapTagEqual, 'tag', src, dest, mapTagsCollection, dryRun);
}

async function syncMapTagsToWebflowRemovals(
    collection: Webflow.Collection,
    src: Map<string, WebsiteMapTag>,
    dest: Map<string, WebflowMapTag>,
    dryRun: boolean
) {
    return syncCollectionToWebflowRemovals(collection, 'tag', src, dest, dryRun);
}

async function syncMapTerrainsToWebflowAdditions(
    src: Map<string, WebsiteMapTerrain>,
    dest: Map<string, WebflowMapTerrain>,
    mapTerrainsCollection: Webflow.Collection,
    dryRun: boolean
) {
    return syncCollectionToWebflowAdditions(WebflowMapTag, isWebsiteMapTerrainEqual, 'terrain', src, dest, mapTerrainsCollection, dryRun);
}

async function syncMapTerrainsToWebflowRemovals(
    collection: Webflow.Collection,
    src: Map<string, WebsiteMapTerrain>,
    dest: Map<string, WebflowMapTerrain>,
    dryRun: boolean
) {
    return syncCollectionToWebflowRemovals(collection, 'terrain', src, dest, dryRun);
}

function getRowyMapTerrains(): Map<string, WebsiteMapTerrain> {
    const terrains = mapSchema['$defs'].terrainType.enum;
    return new Map(terrains.map(t => [t, { name: t, slug: t }]));
}

async function syncMapsToWebflow(
    src: Map<string, WebsiteMapInfo>,
    dest: Map<string, WebflowMapInfo>,
    mapsCollection: Webflow.Collection,
    dryRun: boolean
) {
    const updatesP: Promise<[boolean, WebsiteMapInfo, WebflowMapInfo]>[] = [];
    for (const map of src.values()) {
        const webflowMap = dest.get(map.rowyId);
        if (!webflowMap) {
            const fields = await WebflowMapInfo.generateFields(map);
            console.log(`Adding ${map.name}`);
            if (!dryRun) {
                const item = await limiter.schedule(
                    () => webflow.collections.items.createItem(
                        mapsCollection.id, fieldsToItem(fields)));
                dest.set(map.rowyId, new WebflowMapInfo(item));
            } else {
                console.log(fields);
            }
        } else {
            updatesP.push((async () => [await isWebflowMapInfoEqual(map, webflowMap), map, webflowMap])())
        }
    }
    for (const map of dest.values()) {
        if (!src.has(map.rowyId)) {
            console.log(`Removing ${map.name}`);
            if (!dryRun) {
                await limiter.schedule(() => webflow.collections.items.deleteItem(mapsCollection.id, map.item.id));
                dest.delete(map.rowyId);
            }
        }
    }
    const updates = await Promise.all(updatesP);
    for (const [_, map, webflowMap] of updates.filter(([same]) => !same)) {
        console.log(`Updating ${map.name}`);
        const fields = await WebflowMapInfo.generateFields(map, webflowMap);
        if (!dryRun) {
            const itemPatch = fieldsToItem(fields);
            itemPatch.id = webflowMap.item.id;
            const item = await limiter.schedule(
                () => webflow.collections.items.updateItem(
                    mapsCollection.id, webflowMap.item.id, itemPatch));
            dest.set(map.rowyId, new WebflowMapInfo(item));
        } else {
            console.log(webflowMap);
            console.log(fields);
        }
    }
}

async function publishUpdatedWebflowItems(collection: Webflow.Collection, items: Map<any, { item: Webflow.CollectionItem }>, dryRun: boolean) {
    const itemIds = Array.from(items.values())
        .map(i => i.item)
        .filter(i => !i.lastPublished || Date.parse(i.lastPublished) < Date.parse(i.lastUpdated!))
        .map(i => i.id);
    console.log(`Publishing ${itemIds.length} items`);
    if (!dryRun) {
        const chunkSize = 100;
        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const itemIdsChunk = itemIds.slice(i, i + chunkSize);
            await limiter.schedule(() => webflow.collections.items.publishItem(collection.id, { itemIds: itemIdsChunk }));
        }
    }
}

program.name('sync_to_webflow');

if (!process.env.WEBFLOW_COLLECTION_ID || !process.env.WEBFLOW_API_TOKEN) {
    console.error('Missing WEBFLOW_COLLECTION_ID or WEBFLOW_API_TOKEN');
    process.exit(1);
}
const webflow = new WebflowClient({ accessToken: process.env.WEBFLOW_API_TOKEN });
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 600 });
const mapsCollectionId = process.env.WEBFLOW_COLLECTION_ID;

async function syncCommand(dryRun: boolean) {
    const mapsCollection = await limiter.schedule(() => webflow.collections.get(mapsCollectionId));
    const webflowMaps = await getAllWebflowMaps(mapsCollection);
    const mapTagsCollection = await getFieldCollection('game-tags-ref-2', mapsCollection, webflow);
    const webflowMapTags = await getAllWebflowMapTags(mapTagsCollection);
    const mapTerrainsCollection = await getFieldCollection('terrain-types', mapsCollection, webflow);
    const webflowMapTerrains = await getAllWebflowMapTerrains(mapTerrainsCollection);
    const maps = await readMapList();
    const cdnInfo = await readMapCDNInfos();
    const mapsMetadata = await fetchMapsMetadata(maps);
    const [rowyMapsInfo, rowyMapTagsInfo] = await buildWebflowInfo(maps, cdnInfo, mapsMetadata);
    const rowyMapTerrainsInfo = getRowyMapTerrains();

    try {
        await syncMapTagsToWebflowAdditions(rowyMapTagsInfo, webflowMapTags, mapTagsCollection, dryRun);
        resolveItemRefsInMapInfos(rowyMapsInfo, 'mapTags', webflowMapTags, dryRun);
        await syncMapTerrainsToWebflowAdditions(rowyMapTerrainsInfo, webflowMapTerrains, mapTerrainsCollection, dryRun);
        resolveItemRefsInMapInfos(rowyMapsInfo, 'mapTerrains', webflowMapTerrains, dryRun);
        await syncMapsToWebflow(rowyMapsInfo, webflowMaps, mapsCollection, dryRun);
        await publishUpdatedWebflowItems(mapTerrainsCollection, webflowMapTerrains, dryRun);
        await publishUpdatedWebflowItems(mapTagsCollection, webflowMapTags, dryRun);
        await publishUpdatedWebflowItems(mapsCollection, webflowMaps, dryRun);
        await syncMapTagsToWebflowRemovals(mapTagsCollection, rowyMapTagsInfo, webflowMapTags, dryRun);
        await syncMapTerrainsToWebflowRemovals(mapTerrainsCollection, rowyMapTerrainsInfo, webflowMapTerrains, dryRun);
    } catch (e: any) {
        // To make sure we will get full info from inside of the response.
        if ('message' in e) {
            console.error(e.message);
        } else {
            console.error(e);
        }
        if ('response' in e) {
            console.error(e.response.data);
        }
        process.exit(1);
    }
}

program.command('sync')
    .description('Syncs data from Rowy to Webflow.')
    .option('-d, --dry-run', 'Only compute and print difference, don\'t sync.', false)
    .action(({ dryRun }) => syncCommand(dryRun));

program.command('dump-data')
    .description('Dumps Webflow collection data.')
    .action(async () => {
        const mapsCollection = await limiter.schedule(() => webflow.collections.get(mapsCollectionId));
        const webflowMaps = await getAllWebflowMaps(mapsCollection);
        console.log(util.inspect(webflowMaps, { showHidden: false, depth: null, colors: true }));

        const mapTagsCollection = await getFieldCollection('game-tags-ref-2', mapsCollection, webflow);
        const mapTags = await getAllWebflowMapTags(mapTagsCollection);
        console.log(util.inspect(mapTags, { showHidden: false, depth: null, colors: true }));

        const mapTerrainsCollection = await getFieldCollection('terrain-types', mapsCollection, webflow);
        const webflowTerrains = await getAllWebflowMapTerrains(mapTerrainsCollection);
        console.log(util.inspect(webflowTerrains, { showHidden: false, depth: null, colors: true }));
    });

program.parse();
