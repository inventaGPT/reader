import { randomUUID } from 'crypto';
import { container, singleton } from 'tsyringe';
import { AsyncService, HashManager, marshalErrorLike } from 'civkit';
import TurndownService from 'turndown';
import { Logger } from '../shared/services/logger';
import { PageSnapshot } from './puppeteer';
import { FirebaseStorageBucketControl } from '../shared/services/firebase-storage-bucket';
import { AsyncContext } from '../shared/services/async-context';
import { Threaded } from '../shared/services/threaded';
import { JSDomControl } from './jsdom';
import { AltTextService } from './alt-text';
import { PDFExtractor } from './pdf-extract';
import { cleanAttribute } from '../utils/misc';
import _ from 'lodash';
import { STATUS_CODES } from 'http';


export interface FormattedPage {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    publishedTime?: string;
    html?: string;
    text?: string;
    screenshotUrl?: string;
    screenshot?: Buffer;
    pageshotUrl?: string;
    pageshot?: Buffer;
    links?: { [k: string]: string; };
    images?: { [k: string]: string; };
    warning?: string;
    usage?: {
        total_tokens?: number;
        totalTokens?: number;
        tokens?: number;
    };

    textRepresentation?: string;

    [Symbol.dispose]: () => void;
}

export const md5Hasher = new HashManager('md5', 'hex');

@singleton()
export class SnapshotFormatter extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    turnDownPlugins = [require('turndown-plugin-gfm').tables];

    constructor(
        protected globalLogger: Logger,
        protected jsdomControl: JSDomControl,
        protected altTextService: AltTextService,
        protected pdfExtractor: PDFExtractor,
        protected threadLocal: AsyncContext,
        protected firebaseObjectStorage: FirebaseStorageBucketControl,
    ) {
        super(...arguments);
    }

    override async init() {
        await this.dependencyReady();
        this.emit('ready');
    }


    @Threaded()
    async formatSnapshot(mode: string | 'markdown' | 'html' | 'text' | 'screenshot' | 'pageshot', snapshot: PageSnapshot & {
        screenshotUrl?: string;
        pageshotUrl?: string;
    }, nominalUrl?: URL, urlValidMs = 3600 * 1000 * 4) {
        const t0 = Date.now();
        if (mode === 'screenshot') {
            if (snapshot.screenshot && !snapshot.screenshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.firebaseObjectStorage.saveFile(fid, snapshot.screenshot, {
                    metadata: {
                        contentType: 'image/png',
                    }
                });
                snapshot.screenshotUrl = await this.firebaseObjectStorage.signDownloadUrl(fid, Date.now() + urlValidMs);
            }

            const f = {
                ...this.getGeneralSnapshotMixins(snapshot),
                // html: snapshot.html,
                screenshotUrl: snapshot.screenshotUrl,
            };

            Object.defineProperty(f, 'textRepresentation', { value: `${f.screenshotUrl}\n`, enumerable: false });

            const dt = Date.now() - t0;
            this.logger.info(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

            return f as FormattedPage;
        }
        if (mode === 'pageshot') {
            if (snapshot.pageshot && !snapshot.pageshotUrl) {
                const fid = `instant-screenshots/${randomUUID()}`;
                await this.firebaseObjectStorage.saveFile(fid, snapshot.pageshot, {
                    metadata: {
                        contentType: 'image/png',
                    }
                });
                snapshot.pageshotUrl = await this.firebaseObjectStorage.signDownloadUrl(fid, Date.now() + urlValidMs);
            }

            const f = {
                ...this.getGeneralSnapshotMixins(snapshot),
                html: snapshot.html,
                pageshotUrl: snapshot.pageshotUrl,
            } as FormattedPage;

            Object.defineProperty(f, 'textRepresentation', { value: `${f.pageshotUrl}\n`, enumerable: false });

            const dt = Date.now() - t0;
            this.logger.info(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

            return f;
        }
        if (mode === 'html') {
            const f = {
                ...this.getGeneralSnapshotMixins(snapshot),
                html: snapshot.html,
            } as FormattedPage;

            Object.defineProperty(f, 'textRepresentation', { value: snapshot.html, enumerable: false });

            const dt = Date.now() - t0;
            this.logger.info(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

            return f;
        }

        let pdfMode = false;
        if (snapshot.pdfs?.length && !snapshot.title) {
            const pdf = await this.pdfExtractor.cachedExtract(snapshot.pdfs[0],
                this.threadLocal.get('cacheTolerance')
            );
            if (pdf) {
                pdfMode = true;
                snapshot.title = pdf.meta?.Title;
                snapshot.text = pdf.text || snapshot.text;
                snapshot.parsed = {
                    content: pdf.content,
                    textContent: pdf.content,
                    length: pdf.content?.length,
                    byline: pdf.meta?.Author,
                    lang: pdf.meta?.Language || undefined,
                    title: pdf.meta?.Title,
                    publishedTime: this.pdfExtractor.parsePdfDate(pdf.meta?.ModDate || pdf.meta?.CreationDate)?.toISOString(),
                };
            }
        }

        if (mode === 'text') {
            const f = {
                ...this.getGeneralSnapshotMixins(snapshot),
                text: snapshot.text,
            } as FormattedPage;

            Object.defineProperty(f, 'textRepresentation', { value: snapshot.text, enumerable: false });

            const dt = Date.now() - t0;
            this.logger.info(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

            return f;
        }
        const imgDataUrlToObjectUrl = !Boolean(this.threadLocal.get('keepImgDataUrl'));

        let contentText = '';
        const imageSummary = {} as { [k: string]: string; };
        const imageIdxTrack = new Map<string, number[]>();
        const uid = this.threadLocal.get('uid');
        do {
            if (pdfMode) {
                contentText = snapshot.parsed?.content || snapshot.text;
                break;
            }

            if (
                snapshot.maxElemDepth! > 256 ||
                (!uid && snapshot.elemCount! > 10_000) ||
                snapshot.elemCount! > 70_000
            ) {
                this.logger.warn('Degrading to text to protect the server', { url: snapshot.href });
                contentText = snapshot.text;
                break;
            }

            const jsDomElementOfHTML = this.jsdomControl.snippetToElement(snapshot.html, snapshot.href);
            let toBeTurnedToMd = jsDomElementOfHTML;
            let turnDownService = this.getTurndown({ url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
            if (mode !== 'markdown' && snapshot.parsed?.content) {
                const jsDomElementOfParsed = this.jsdomControl.snippetToElement(snapshot.parsed.content, snapshot.href);
                const par1 = this.jsdomControl.runTurndown(turnDownService, jsDomElementOfHTML);
                const par2 = snapshot.parsed.content ? this.jsdomControl.runTurndown(turnDownService, jsDomElementOfParsed) : '';

                // If Readability did its job
                if (par2.length >= 0.3 * par1.length) {
                    turnDownService = this.getTurndown({ noRules: true, url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
                    if (snapshot.parsed.content) {
                        toBeTurnedToMd = jsDomElementOfParsed;
                    }
                }
            }

            for (const plugin of this.turnDownPlugins) {
                turnDownService = turnDownService.use(plugin);
            }
            const urlToAltMap: { [k: string]: string | undefined; } = {};
            if (snapshot.imgs?.length && this.threadLocal.get('withGeneratedAlt')) {
                const tasks = _.uniqBy((snapshot.imgs || []), 'src').map(async (x) => {
                    const r = await this.altTextService.getAltText(x).catch((err: any) => {
                        this.logger.warn(`Failed to get alt text for ${x.src}`, { err: marshalErrorLike(err) });
                        return undefined;
                    });
                    if (r && x.src) {
                        urlToAltMap[x.src.trim()] = r;
                    }
                });

                await Promise.all(tasks);
            }
            let imgIdx = 0;
            turnDownService.addRule('img-generated-alt', {
                filter: 'img',
                replacement: (_content, node: any) => {
                    let linkPreferredSrc = (node.getAttribute('src') || '').trim();
                    if (!linkPreferredSrc || linkPreferredSrc.startsWith('data:')) {
                        const dataSrc = (node.getAttribute('data-src') || '').trim();
                        if (dataSrc && !dataSrc.startsWith('data:')) {
                            linkPreferredSrc = dataSrc;
                        }
                    }

                    let src;
                    try {
                        src = new URL(linkPreferredSrc, snapshot.rebase || nominalUrl).toString();
                    } catch (_err) {
                        void 0;
                    }
                    const alt = cleanAttribute(node.getAttribute('alt'));
                    if (!src) {
                        return '';
                    }
                    const mapped = urlToAltMap[src];
                    const imgSerial = ++imgIdx;
                    const idxArr = imageIdxTrack.has(src) ? imageIdxTrack.get(src)! : [];
                    idxArr.push(imgSerial);
                    imageIdxTrack.set(src, idxArr);

                    if (mapped) {
                        imageSummary[src] = mapped || alt;

                        if (src?.startsWith('data:') && imgDataUrlToObjectUrl) {
                            const mappedUrl = new URL(`blob:${nominalUrl?.origin || ''}/${md5Hasher.hash(src)}`);
                            mappedUrl.protocol = 'blob:';

                            return `![Image ${imgIdx}: ${mapped || alt}](${mappedUrl})`;
                        }

                        return `![Image ${imgIdx}: ${mapped || alt}](${src})`;
                    }

                    imageSummary[src] = alt || '';

                    if (src?.startsWith('data:') && imgDataUrlToObjectUrl) {
                        const mappedUrl = new URL(`blob:${nominalUrl?.origin || ''}/${md5Hasher.hash(src)}`);
                        mappedUrl.protocol = 'blob:';

                        return alt ? `![Image ${imgIdx}: ${alt}](${mappedUrl})` : `![Image ${imgIdx}](${mappedUrl})`;
                    }

                    return alt ? `![Image ${imgIdx}: ${alt}](${src})` : `![Image ${imgIdx}](${src})`;
                }
            });

            if (toBeTurnedToMd) {
                try {
                    contentText = this.jsdomControl.runTurndown(turnDownService, toBeTurnedToMd).trim();
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown({ url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
                    try {
                        contentText = this.jsdomControl.runTurndown(vanillaTurnDownService, toBeTurnedToMd).trim();
                    } catch (err2) {
                        this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                    }
                }
            }

            if (
                !contentText || (contentText.startsWith('<') && contentText.endsWith('>'))
                && toBeTurnedToMd !== jsDomElementOfHTML
            ) {
                try {
                    contentText = this.jsdomControl.runTurndown(turnDownService, snapshot.html);
                } catch (err) {
                    this.logger.warn(`Turndown failed to run, retrying without plugins`, { err });
                    const vanillaTurnDownService = this.getTurndown({ url: snapshot.rebase || nominalUrl, imgDataUrlToObjectUrl });
                    try {
                        contentText = this.jsdomControl.runTurndown(vanillaTurnDownService, snapshot.html);
                    } catch (err2) {
                        this.logger.warn(`Turndown failed to run, giving up`, { err: err2 });
                    }
                }
            }
            if (!contentText || (contentText.startsWith('<') || contentText.endsWith('>'))) {
                contentText = snapshot.text;
            }
        } while (false);

        const cleanText = (contentText || '').trim();

        const formatted: FormattedPage = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            description: (snapshot.description || '').trim(),
            url: nominalUrl?.toString() || snapshot.href?.trim(),
            content: cleanText,
            publishedTime: snapshot.parsed?.publishedTime || undefined,
            [Symbol.dispose]: () => { },
        };

        if (snapshot.status) {
            const code = snapshot.status;
            const n = code - 200;
            if (n < 0 || n >= 200) {
                const text = snapshot.statusText || STATUS_CODES[code];
                formatted.warning = `Target URL returned error ${code}${text? `: ${text}` : ''}`;
            }
        }

        if (this.threadLocal.get('withImagesSummary')) {
            formatted.images =
                _(imageSummary)
                    .toPairs()
                    .map(
                        ([url, alt], i) => {
                            return [`Image ${(imageIdxTrack?.get(url) || [i + 1]).join(',')}${alt ? `: ${alt}` : ''}`, url];
                        }
                    ).fromPairs()
                    .value();
        }
        if (this.threadLocal.get('withLinksSummary')) {
            formatted.links = _.invert(this.jsdomControl.inferSnapshot(snapshot).links || {});
        }

        const textRepresentation = (function (this: typeof formatted) {
            if (mode === 'markdown') {
                return this.content as string;
            }

            const mixins = [];
            if (this.publishedTime) {
                mixins.push(`Published Time: ${this.publishedTime}`);
            }
            const suffixMixins = [];
            if (this.images) {
                const imageSummaryChunks = ['Images:'];
                for (const [k, v] of Object.entries(this.images)) {
                    imageSummaryChunks.push(`- ![${k}](${v})`);
                }
                if (imageSummaryChunks.length === 1) {
                    imageSummaryChunks.push('This page does not seem to contain any images.');
                }
                suffixMixins.push(imageSummaryChunks.join('\n'));
            }
            if (this.links) {
                const linkSummaryChunks = ['Links/Buttons:'];
                for (const [k, v] of Object.entries(this.links)) {
                    linkSummaryChunks.push(`- [${k}](${v})`);
                }
                if (linkSummaryChunks.length === 1) {
                    linkSummaryChunks.push('This page does not seem to contain any buttons/links.');
                }
                suffixMixins.push(linkSummaryChunks.join('\n'));
            }

            if (this.warning) {
                mixins.push(`Warning: ${this.warning}`);
            }

            return `Title: ${this.title}

URL Source: ${this.url}
${mixins.length ? `\n${mixins.join('\n\n')}\n` : ''}
Markdown Content:
${this.content}
${suffixMixins.length ? `\n${suffixMixins.join('\n\n')}\n` : ''}`;
        }).call(formatted);

        Object.defineProperty(formatted, 'textRepresentation', { value: textRepresentation, enumerable: false });

        const dt = Date.now() - t0;
        this.logger.info(`Formatting took ${dt}ms`, { mode, url: nominalUrl?.toString(), dt });

        return formatted as FormattedPage;
    }

    getGeneralSnapshotMixins(snapshot: PageSnapshot) {
        let inferred;
        const mixin: any = {};
        if (this.threadLocal.get('withImagesSummary')) {
            inferred ??= this.jsdomControl.inferSnapshot(snapshot);
            const imageSummary = {} as { [k: string]: string; };
            const imageIdxTrack = new Map<string, number[]>();

            let imgIdx = 0;

            for (const img of inferred.imgs) {
                const imgSerial = ++imgIdx;
                const idxArr = imageIdxTrack.has(img.src) ? imageIdxTrack.get(img.src)! : [];
                idxArr.push(imgSerial);
                imageIdxTrack.set(img.src, idxArr);
                imageSummary[img.src] = img.alt || '';
            }

            mixin.images =
                _(imageSummary)
                    .toPairs()
                    .map(
                        ([url, alt], i) => {
                            return [`Image ${(imageIdxTrack?.get(url) || [i + 1]).join(',')}${alt ? `: ${alt}` : ''}`, url];
                        }
                    ).fromPairs()
                    .value();
        }
        if (this.threadLocal.get('withLinksSummary')) {
            inferred ??= this.jsdomControl.inferSnapshot(snapshot);
            mixin.links = _.invert(inferred.links || {});
        }
        if (snapshot.status) {
            const code = snapshot.status;
            const n = code - 200;
            if (n < 0 || n >= 200) {
                const text = snapshot.statusText || STATUS_CODES[code];
                mixin.warning = `Target URL returned error ${code}${text ? `: ${text}` : ''}`;
            }
        }

        return mixin;
    }

    getTurndown(options?: {
        noRules?: boolean | string,
        url?: string | URL;
        imgDataUrlToObjectUrl?: boolean;
    }) {
        const turnDownService = new TurndownService({
            codeBlockStyle: 'fenced',
            preformattedCode: true,
        } as any);
        if (!options?.noRules) {
            turnDownService.addRule('remove-irrelevant', {
                filter: ['meta', 'style', 'script', 'noscript', 'link', 'textarea', 'select'],
                replacement: () => ''
            });
            turnDownService.addRule('truncate-svg', {
                filter: 'svg' as any,
                replacement: () => ''
            });
            turnDownService.addRule('title-as-h1', {
                filter: ['title'],
                replacement: (innerText) => `${innerText}\n===============\n`
            });
        }

        if (options?.imgDataUrlToObjectUrl) {
            turnDownService.addRule('data-url-to-pseudo-object-url', {
                filter: (node) => Boolean(node.tagName === 'IMG' && node.getAttribute('src')?.startsWith('data:')),
                replacement: (_content, node: any) => {
                    const src = (node.getAttribute('src') || '').trim();
                    const alt = cleanAttribute(node.getAttribute('alt')) || '';

                    if (options.url) {
                        const refUrl = new URL(options.url);
                        const mappedUrl = new URL(`blob:${refUrl.origin}/${md5Hasher.hash(src)}`);

                        return `![${alt}](${mappedUrl})`;
                    }

                    return `![${alt}](blob:${md5Hasher.hash(src)})`;
                }
            });
        }

        turnDownService.addRule('improved-paragraph', {
            filter: 'p',
            replacement: (innerText) => {
                const trimmed = innerText.trim();
                if (!trimmed) {
                    return '';
                }

                return `${trimmed.replace(/\n{3,}/g, '\n\n')}\n\n`;
            }
        });
        turnDownService.addRule('improved-inline-link', {
            filter: function (node, options) {
                return Boolean(
                    options.linkStyle === 'inlined' &&
                    node.nodeName === 'A' &&
                    node.getAttribute('href')
                );
            },

            replacement: function (content, node: any) {
                let href = node.getAttribute('href');
                if (href) href = href.replace(/([()])/g, '\\$1');
                let title = cleanAttribute(node.getAttribute('title'));
                if (title) title = ' "' + title.replace(/"/g, '\\"') + '"';

                const fixedContent = content.replace(/\s+/g, ' ').trim();
                let fixedHref = href.replace(/\s+/g, '').trim();
                if (options?.url) {
                    try {
                        fixedHref = new URL(fixedHref, options.url).toString();
                    } catch (_err) {
                        void 0;
                    }
                }

                return `[${fixedContent}](${fixedHref}${title || ''})`;
            }
        });
        turnDownService.addRule('improved-code', {
            filter: function (node: any) {
                let hasSiblings = node.previousSibling || node.nextSibling;
                let isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;

                return node.nodeName === 'CODE' && !isCodeBlock;
            },

            replacement: function (inputContent: any) {
                if (!inputContent) return '';
                let content = inputContent;

                let delimiter = '`';
                let matches = content.match(/`+/gm) || [];
                while (matches.indexOf(delimiter) !== -1) delimiter = delimiter + '`';
                if (content.includes('\n')) {
                    delimiter = '```';
                }

                let extraSpace = delimiter === '```' ? '\n' : /^`|^ .*?[^ ].* $|`$/.test(content) ? ' ' : '';

                return delimiter + extraSpace + content + (delimiter === '```' && !content.endsWith(extraSpace) ? extraSpace : '') + delimiter;
            }
        });

        return turnDownService;
    }


}

const snapshotFormatter = container.resolve(SnapshotFormatter);

export default snapshotFormatter;
