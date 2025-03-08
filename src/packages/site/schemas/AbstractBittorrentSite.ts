import {
  ESearchResultParseStatus,
  IElementQuery,
  ISearchResult,
  ISiteMetadata,
  ITorrent,
  NeedLoginError,
  NoTorrentsError,
  IAdvancedSearchRequestConfig,
  IAdvanceKeywordSearchConfig,
  ISearchInput,
  ITorrentTag,
  ISiteUserConfig,
} from "../types";
import {
  definedFilters,
  filterNames,
  TQueryFilter,
  cfDecodeEmail,
  parseSizeString,
  parseTimeWithZone,
  tryToNumber,
} from "../utils";
import axios, { type AxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";
import Sizzle from "sizzle";
import urlJoin from "url-join";
import { get, isEmpty, set } from "es-toolkit/compat";
import { chunk, pascalCase, pick, toMerged, union } from "es-toolkit";
import { setupCache } from "axios-cache-interceptor";

setupCache(axios);

export const SchemaMetadata: Partial<ISiteMetadata> = {
  version: -1,
  search: {},
};

// 适用于公网BT站点，同时也作为 所有站点方法 的基类
export default class BittorrentSite {
  public readonly metadata: ISiteMetadata; // 实际过程中使用的配置文件
  public readonly userConfig: ISiteUserConfig;

  constructor(metadata: ISiteMetadata, userConfig: ISiteUserConfig = {}) {
    this.metadata = toMerged(metadata, userConfig.merge ?? {});
    this.userConfig = userConfig;
  }

  get url(): string {
    return this.userConfig.url ?? this.metadata.urls[0];
  }

  get isOnline(): boolean {
    return !(this.userConfig.isOffline ?? false);
  }

  get allowSearch(): boolean {
    return this.isOnline && !!this.metadata.search && !(this.userConfig.allowSearch === false);
  }

  /**
   * 登录检查方法，对于公开站点，该方法一定直接返回 True
   * @param raw
   */
  protected loggedCheck(raw: AxiosResponse): boolean {
    return true;
  }

  public async request<T>(axiosConfig: AxiosRequestConfig, checkLogin: boolean = true): Promise<AxiosResponse<T>> {
    // 统一设置一些 AxiosRequestConfig， 当作默认值
    axiosConfig.baseURL ??= this.url;
    axiosConfig.url ??= "/";

    let req: AxiosResponse;
    try {
      req = await axios.request<T>(axiosConfig);

      // 全局性的替换 span.__cf_email__
      if (axiosConfig.responseType === "document") {
        const doc = req.data;

        // 进行简单的检查，防止无意义的替换
        if (doc instanceof Document && doc.documentElement.outerHTML.search("__cf_email__")) {
          const cfProtectSpan = Sizzle(".__cf_email__", doc);

          cfProtectSpan.forEach((element) => {
            element.replaceWith(cfDecodeEmail((element as HTMLElement).dataset.cfemail!));
          });
        }

        req.data = doc;
      }
    } catch (e) {
      req = (e as AxiosError).response!;
      if (req.status >= 400) {
        throw Error(`Network Error: ${req.status} ${req.statusText || ""}`.trim());
      }
    }

    if (checkLogin && !this.loggedCheck(req)) {
      throw new NeedLoginError(); // FIXME i18n
    }

    return req;
  }

  /**
   * 种子搜索方法
   * @param keywords
   * @param searchEntry
   */
  public async getSearchResult(
    keywords?: string,
    searchEntry: IAdvancedSearchRequestConfig = {},
  ): Promise<ISearchResult> {
    const result: ISearchResult = {
      data: [],
      status: ESearchResultParseStatus.unknownError,
    };

    // 0. 检查该站点是否允许搜索
    if (!this.allowSearch) {
      result.status = ESearchResultParseStatus.passSearch;
      return result;
    }

    // 1. 形成搜索入口，默认情况下需要合并 this.config.search
    if (searchEntry && (isEmpty(searchEntry) || searchEntry.merge !== false)) {
      searchEntry = toMerged(this.metadata.search!, searchEntry)!;
    } else {
      searchEntry = searchEntry ?? this.metadata.search!;
    }

    // 2. 生成对应站点的基础 requestConfig
    let requestConfig: AxiosRequestConfig = toMerged(
      { url: "/", responseType: "document", params: {}, data: {} }, // 最基础的垫片，baseUrl 会在 request 方法中被补全，此处不用额外声明
      searchEntry.requestConfig || {}, // 使用默认配置覆盖垫片配置，如果是站点是 json 返回，应该在此处覆写 responseType，并准备基础参数
    );

    // 3. 预检查 keywords 是否为高级搜索词，如果是，则查找对应的 searchEntry.advanceKeywordParams[*] 并改写 keywords
    let advanceKeywordType: string | undefined;
    let advanceKeywordConfig: IAdvanceKeywordSearchConfig | false = false;
    if (keywords && searchEntry.advanceKeywordParams) {
      for (const [advanceField, advanceConfig] of Object.entries(searchEntry.advanceKeywordParams)) {
        if (keywords.startsWith(`${advanceField}|`)) {
          // 检查是否跳过
          if (advanceConfig === false || advanceConfig.enabled === false) {
            result.status = ESearchResultParseStatus.passSearch;
            return result;
          }

          // 改写 keywords 并缓存 transformer
          keywords = keywords?.replace(`${advanceField}|`, "");
          advanceKeywordType = advanceField;
          advanceKeywordConfig = advanceConfig;
          break;
        }
      }
    }

    // 4. 首先将搜索关键词根据 keywordsParam 放入请求配置中，注意如果是 advanceKeyword 已经被去除了前缀 `${advanceKeywordType}|`
    if (keywords) {
      set(requestConfig, searchEntry.keywordPath || "params.keywords", keywords || "");
    }

    // 5. 如果是高级搜索词搜索，则在对应基础上改写 AxiosRequestConfig
    if (advanceKeywordConfig) {
      if (advanceKeywordConfig.requestConfig) {
        requestConfig = toMerged(requestConfig, advanceKeywordConfig.requestConfig || {});
      }

      if (typeof advanceKeywordConfig.requestConfigTransformer === "function") {
        requestConfig = advanceKeywordConfig.requestConfigTransformer({ keywords, searchEntry, requestConfig });
      }
    }

    // 6. 如果有 requestConfigTransformer，则会在最后一步对请求配置进行处理
    if (typeof searchEntry.requestConfigTransformer === "function") {
      // 一般情况下，此项可以用于调试，如： (config) => {console.log(config); return config;}
      requestConfig = searchEntry.requestConfigTransformer({ keywords, searchEntry, requestConfig });
    }

    // 7. 请求页面并转化为document
    try {
      const req = await this.request(requestConfig);
      result.data = await this.transformSearchPage(req.data, { keywords, searchEntry, requestConfig });
      result.status = ESearchResultParseStatus.success;
    } catch (e) {
      if (e instanceof NeedLoginError) {
        result.status = ESearchResultParseStatus.needLogin;
      } else if (e instanceof NoTorrentsError) {
        result.status = ESearchResultParseStatus.noResults;
      } else {
        result.status = ESearchResultParseStatus.parseError;
      }
    }
    return result;
  }

  /**
   * @warning 此方法不可以在 getFieldData 的 filters 中使用，
   *          对于约定的 url, link 本方法会自动调用进行补全
   * @param uri
   * @param requestConfig
   */
  protected fixLink(uri: string, requestConfig: AxiosRequestConfig): string {
    let url = uri;

    if (uri.length > 0 && !uri.startsWith("magnet:")) {
      const baseUrl = requestConfig.baseURL || this.url;
      if (uri.startsWith("//")) {
        // 当 传入的uri 以 /{2,} 开头时，被转换成类似 https?:///xxxx/xxxx 的形式，
        // 虽不符合url规范，但是浏览器容错高，所以不用担心 2333
        const urlHelper = new URL(baseUrl);
        url = `${urlHelper.protocol}:${uri}`;
      } else if (uri.slice(0, 4) !== "http") {
        url = urlJoin(baseUrl, uri.replace(/^\./, ""));
      }
    }

    return url;
  }

  /**
   * getFieldData 的上层方法，目的是直接获取一批数据，并以字典形式返回
   * @param element
   * @param fields
   * @param selectors
   * @protected
   */
  protected getFieldsData<
    G extends "search" | "detail" | "userInfo",
    S extends Required<Required<ISiteMetadata>[G]>["selectors"],
  >(element: Element | object, fields: (keyof S)[], selectors: S): { [key in keyof S]?: any } {
    const ret: { [key in keyof S]?: any } = {};

    // @ts-ignore
    for (const [key, selector] of Object.entries(pick(selectors, fields))) {
      // @ts-ignore
      ret[key] = this.getFieldData(element, selector as IElementQuery);
    }

    return ret;
  }

  protected getFieldData(element: Element | object, elementQuery: IElementQuery): any {
    let query: any = String(elementQuery.text ?? "");

    if (elementQuery.selector) {
      let usedSelector: string;
      const selectors = ([] as string[]).concat(elementQuery.selector);
      for (usedSelector of selectors) {
        if (element instanceof Node) {
          // 这里我们预定义一个特殊的 Css Selector，即不进行子元素选择
          const another = (
            usedSelector === ":self" ? element : Sizzle(usedSelector, element as Element | Document)[0]
          ) as HTMLElement;
          if (another) {
            if (elementQuery.elementProcess) {
              query = this.runQueryFilters<string>(another, elementQuery.elementProcess);
            } else if (elementQuery.case) {
              for (const [match, value] of Object.entries(elementQuery.case)) {
                if (Sizzle.matchesSelector(another, match)) {
                  query = value ?? query;
                  break;
                }
              }
            } else if (elementQuery.data) {
              query = another.dataset[elementQuery.data] ?? query;
            } else if (elementQuery.attr) {
              query = another.getAttribute(elementQuery.attr) ?? query;
            } else {
              query = another.innerText.replace(/\n/gi, " ") || query;
            }
          }
        } else {
          query = usedSelector === ":self" ? element : get(element, usedSelector)!;
        }

        // noinspection SuspiciousTypeOfGuard
        if (typeof query === "string") {
          query = query.trim();
        }
        if (query !== "") {
          break;
        }
      }

      if (selectors.length > 0 && elementQuery.switchFilters?.[usedSelector!]) {
        query = this.runQueryFilters(query, elementQuery.switchFilters[usedSelector!]);
      } else if (elementQuery.filters && elementQuery.filters?.length > 0) {
        query = this.runQueryFilters(query, elementQuery.filters);
      }
    }

    // noinspection SuspiciousTypeOfGuard
    if (typeof query === "string") {
      query = query.trim(); // 去除空格
      if (/^-?\d+$/.test(query)) {
        // 尽可能的将返回值转成数字类型
        query = isNaN(parseInt(query)) ? 0 : parseInt(query);
      }
    }

    return query;
  }

  protected runQueryFilters<T>(query: any, filters: TQueryFilter[] | TQueryFilter): T {
    const realFilters = ([] as TQueryFilter[]).concat(filters);
    for (const realFilter of realFilters) {
      if (typeof realFilter === "function") {
        query = realFilter(query);
      } else if (realFilter?.name) {
        const { name, args = [] } = realFilter;
        if (filterNames.includes(name)) {
          query = definedFilters[name](query, args);
        }
      }
    }

    return query;
  }

  /**
   * 如何解析 JSON 或者 Document，获得种子详情列表
   */
  protected async transformSearchPage(doc: Document | object | any, searchConfig: ISearchInput): Promise<ITorrent[]> {
    const { searchEntry, requestConfig } = searchConfig;
    if (!searchEntry!.selectors?.rows) {
      throw Error("列表选择器未定义");
    }

    const rowsSelector = searchEntry!.selectors.rows;
    const torrents: ITorrent[] = [];

    let trs: any;

    if (doc instanceof Document) {
      trs = Sizzle(rowsSelector.selector as string, doc);
      if (rowsSelector.filter) {
        trs = rowsSelector.filter(trs);
      } else {
        /**
         * 应对某些站点连用多个tr表示一个种子的情况，将多个tr使用 <div> 包裹成一个 Element，
         * 这种情况下，子选择器就可以写成 `tr:nth-child(1) xxxx` 来精确
         */
        const rowMergeDeep: number = rowsSelector.merge || 1;
        if (trs.length > 0 && rowMergeDeep > 1) {
          const newTrs: Element[] = [];

          chunk(trs, rowMergeDeep).forEach((chunkTr) => {
            const wrapperDiv = doc.createElement("div");
            chunkTr.forEach((tr) => {
              wrapperDiv.appendChild(tr as Element);
            });
            newTrs.push(wrapperDiv);
          });

          trs = newTrs;
        }
      }
    } else {
      // 同样定义一个 :self 以防止对于JSON返回的情况下，所有items在顶层字典（实际是 Object[] ）下
      trs = rowsSelector.selector === ":self" ? doc : get(doc, rowsSelector.selector as string);

      if (rowsSelector.filter) {
        trs = rowsSelector.filter(trs);
      }
    }

    // 如果没有搜索到种子，则抛出 NoTorrentsError
    if (trs.length === 0) {
      throw new NoTorrentsError();
    }

    trs?.forEach((tr: any) => {
      torrents.push(this.parseWholeTorrentFromRow({}, tr, searchConfig!) as ITorrent);
    });

    return torrents;
  }

  protected parseWholeTorrentFromRow(
    torrent: Partial<ITorrent> = {},
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    const { searchEntry, requestConfig } = searchConfig;

    // FIXME 对于每个 searchEntry，其需要获取的 torrentKey 应该都是一样的，但是目前会导致在每个loop中都重复生成相同的 key，但是没太大关系
    const definedTorrentSelectorKey = Object.keys(searchEntry!.selectors!).filter((key) => key !== "rows");
    const defaultTorrentSelectorKey = [
      "id",
      "title",
      "subTitle",
      "url",
      "link",
      "time",
      "size",
      "author",
      "seeders",
      "leechers",
      "completed",
      "comments",
      "category",
      "tags",
      "progress",
      "status",
    ];

    /**
     * 对种子文件的任意非rows属性进行处理，例如 "id" 属性：
     * - 如果对应的实例中有 parseTorrentRowForId 方法，则调用该方法，注意该方法会需要返回更新后的 torrent 对象
     * - 不然则使用 selectors.id 的定义来获取，此时只更新 torrent 的id属性
     */
    for (const key of union(definedTorrentSelectorKey, defaultTorrentSelectorKey) as (keyof Omit<ITorrent, "site">)[]) {
      // 如果已经有值，则跳过
      if (Object.hasOwn(torrent, key)) {
        continue;
      }

      const dynamicParseFuncKey = `parseTorrentRowFor${pascalCase(key)}` as keyof this;
      if (dynamicParseFuncKey in this && typeof this[dynamicParseFuncKey] === "function") {
        torrent = this[dynamicParseFuncKey](torrent, row, searchConfig);
      } else if (searchEntry!.selectors![key]) {
        torrent[key] = this.getFieldData(row, searchEntry!.selectors![key] as IElementQuery);
      }
    }

    // 对获取到的种子进行一些通用的处理
    torrent.site ??= this.metadata.id; // 补全种子的 site 属性
    torrent.id ??= tryToNumber(torrent.url || torrent.link); // 补全种子的 id 属性，如果不存在，则由 url, link 属性替代
    torrent.url = this.fixLink(torrent.url as string, requestConfig!);
    torrent.link = this.fixLink(torrent.link as string, requestConfig!);
    if (typeof (torrent.size as unknown) === "string") {
      torrent.size = parseSizeString(torrent.size as unknown as string);
    }
    torrent.size = tryToNumber(torrent.size);
    torrent.seeders = tryToNumber(torrent.seeders);
    torrent.leechers = tryToNumber(torrent.leechers);
    torrent.completed = tryToNumber(torrent.completed);
    torrent.comments = tryToNumber(torrent.comments);
    torrent.category = tryToNumber(torrent.category);
    torrent.status = tryToNumber(torrent.status);
    torrent.time = parseTimeWithZone(torrent.time as unknown as string, this.metadata.timezoneOffset || "+0000");

    // 在此基础上，不同 schema 可以复写处理过程
    torrent = this.fixParsedTorrent(torrent as ITorrent, row, searchConfig);
    return torrent;
  }

  protected parseTorrentTagsFromRow(
    torrent: Partial<ITorrent>,
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    if (searchConfig?.searchEntry?.selectors?.tags) {
      const tags: ITorrentTag[] = [];
      searchConfig.searchEntry.selectors.tags.forEach(({ name, selector }) => {
        if (row instanceof Element) {
          if (Sizzle(selector, row).length > 0) {
            tags.push({ name });
          }
        } else {
          if (get(row, selector)) {
            tags.push({ name });
          }
        }
      });
      torrent.tags = tags;
    }

    return torrent;
  }

  protected fixParsedTorrent(
    torrent: ITorrent,
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): ITorrent {
    return torrent;
  }

  async getTorrentPageLink(torrent: ITorrent): Promise<string> {
    return torrent.url;
  }

  async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    if (!torrent.link && this.metadata?.detail?.selectors?.link) {
      const { data } = await this.request<any>(
        toMerged({ responseType: "document", url: torrent.url }, this.metadata.detail?.requestConfig!),
      );
      return this.getFieldData(data, this.metadata.detail.selectors.link);
    }

    return torrent.link;
  }
}
