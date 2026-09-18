// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// export-gen.ts — 文档导出生成器（老 q3 q3.js 100% 移植：RTF/.doc + DOCX + 附件索引）
//
// 纯 Node（零 Electron 依赖）——可脱离主进程独立测试。
//   · escapeRtf / createRtfPicture / generateRtfDocument  = 老实现逐字移植
//   · DOCX = 手写最小 OOXML（[Content_Types] + rels + document.xml + core.xml）
//     + ZipWriter——取代老的 npm docx 库（零依赖 + 同款版式：字号/对齐/间距/制表位/图片内联）
//   · 附件索引（序号/文件名/类型/大小/SHA256 前 16 位 + 完整哈希表）两格式同源
// ============================================================================

import * as path from 'path';
import { ZipWriter } from './zip-writer';

// ── 常量（老 q3 原值）──
export const EXPORT_MAX_WIDTH = 512;
export const EXPORT_MAX_HEIGHT = 288;
export const FILENAME_MAX_LENGTH = 22;

// 制表位（老 TAB_POS_1..4，单位 twips）
const TAB_POS = [500, 4500, 5500, 6800];

export interface AttachmentEntry {
    name: string;
    ext: string;
    size: number;
    sha256: string;
}

/** 老 global.formatBytes 逐字移植（"218.2 MB" 带空格） */
export function formatBytes(size: number | null | undefined, decimals = 1): string {
    if (size == null || isNaN(size as number)) { return '?'; }
    const units = ['B', 'KB', 'MB', 'GB'];
    let idx = 0;
    let val = Number(size);
    while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
    return `${val.toFixed(idx > 0 ? decimals : 0)} ${units[idx]}`;
}

/** 老 truncateFilename 逐字移植（22 字符上限，中文按字符数） */
export function truncateFilename(filename: string, maxLength = FILENAME_MAX_LENGTH): string {
    if (!filename) { return filename; }
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    if (baseName.length <= maxLength) { return filename; }
    return baseName.substring(0, maxLength) + '...' + ext;
}

// ═══════════════════════════════════════════════════════════════
// RTF（.doc）
// ═══════════════════════════════════════════════════════════════

/** 老 escapeRtf 逐字移植 */
export function escapeRtf(text: string): string {
    if (!text) { return ''; }
    let result = '';
    for (const char of text) {
        const cpv = char.codePointAt(0)!;
        if (cpv === 0x5c) { result += '\\\\'; }
        else if (cpv === 0x7b) { result += '\\{'; }
        else if (cpv === 0x7d) { result += '\\}'; }
        else if (cpv === 0x0a) { result += '\\line '; }
        else if (cpv === 0x0d) { continue; }
        else if (cpv === 0x09) { result += '\\tab '; }
        else if (cpv > 127) {
            if (cpv > 0xffff) {
                const hi = Math.floor((cpv - 0x10000) / 0x400) + 0xd800;
                const lo = ((cpv - 0x10000) % 0x400) + 0xdc00;
                const hiSigned = hi > 32767 ? hi - 65536 : hi;
                const loSigned = lo > 32767 ? lo - 65536 : lo;
                result += `\\u${hiSigned}?\\u${loSigned}?`;
            } else {
                const rtfCode = cpv > 32767 ? cpv - 65536 : cpv;
                result += `\\u${rtfCode}?`;
            }
        } else {
            result += char;
        }
    }
    return result;
}

/** 老 createRtfPicture 逐字移植（贴页面宽策略：大图缩到页宽、小图不放大） */
export function createRtfPicture(pngBuffer: Buffer, width: number, height: number): string {
    const PAGE_CONTENT_WIDTH_TWIPS = 9000; // ~16cm
    const twipsPerPixel = 15;
    const origWidthTwips = width * twipsPerPixel;
    const picwgoal = Math.min(origWidthTwips, PAGE_CONTENT_WIDTH_TWIPS);
    const pichgoal = Math.round(picwgoal * (height / width));
    const hexData = pngBuffer.toString('hex');
    return `{\\pict\\pngblip\\picw${width}\\pich${height}\\picwgoal${picwgoal}\\pichgoal${pichgoal}\r\n${hexData}\r\n}`;
}

export type ExportElement =
    | { type: 'text'; content: string }
    | { type: 'image'; pngBuffer: Buffer; width: number; height: number; originalMark: string | null }
    | { type: 'image_error'; path: string };

export interface ExportTexts {
    attachmentIndex: string;
    colIndex: string;
    colFileName: string;
    colType: string;
    colSize: string;
    colSha256Short: string;
    fullSha256: string;
    mediaConversionFailed: (p: string) => string;
}

/** 老 generateRtfDocument 逐字移植 */
export function generateRtfDocument(elements: ExportElement[], attachments: AttachmentEntry[], title: string, t: ExportTexts): string {
    const parts: string[] = [];
    parts.push('{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033');
    parts.push('{\\fonttbl');
    parts.push('{\\f0\\fswiss\\fcharset0 Arial;}');
    parts.push('}');
    parts.push('{\\colortbl ;\\red0\\green0\\blue0;}');
    parts.push('\\paperw11906\\paperh16838');
    parts.push('\\margl1440\\margr1440\\margt1440\\margb1440');
    parts.push('\\widowctrl\\ftnbj\\aenddoc');

    if (title) {
        parts.push(`\\pard\\ltrpar\\qc\\sb200\\sa400\\f0\\fs36\\b ${escapeRtf(title)}\\b0\\fs22\\par`);
    }

    parts.push('\\pard\\ltrpar\\plain\\f0\\fs22');

    for (const elem of elements) {
        if (elem.type === 'text') {
            const lines = elem.content.split(/\r?\n/);
            for (const line of lines) {
                parts.push(
                    line.length === 0
                        ? '\\pard\\ltrpar\\sa0\\par'
                        : `\\pard\\ltrpar\\ql\\f0\\fs22 ${escapeRtf(line)}\\par`,
                );
            }
        } else if (elem.type === 'image') {
            if (elem.originalMark) {
                parts.push(`\\pard\\ltrpar\\ql\\sb200\\sa100\\f0\\fs22 ${escapeRtf(elem.originalMark)}\\par`);
            }
            parts.push('\\pard\\ltrpar\\ql\\sa200');
            parts.push(createRtfPicture(elem.pngBuffer, elem.width, elem.height));
            parts.push('\\par');
            parts.push('\\pard\\ltrpar\\ql\\f0\\fs22');
        } else if (elem.type === 'image_error') {
            parts.push(`\\pard\\ltrpar\\f0\\fs22 [${escapeRtf(t.mediaConversionFailed(elem.path))}]\\par`);
        }
    }

    if (attachments.length > 0) {
        parts.push('\\pard\\ltrpar\\sb600\\sa200\\brdrb\\brdrs\\brdrw10\\brsp20 \\par');
        parts.push('\\pard\\ltrpar\\sb200\\sa200\\f0\\fs28\\b');
        parts.push(escapeRtf(t.attachmentIndex));
        parts.push('\\b0\\fs22\\par');
        parts.push('\\pard\\ltrpar\\tx500\\tx4500\\tx5500\\tx6800\\sa100\\f0\\fs18\\b');
        parts.push(
            escapeRtf(t.colIndex) + '\\tab ' +
            escapeRtf(t.colFileName) + '\\tab ' +
            escapeRtf(t.colType) + '\\tab ' +
            escapeRtf(t.colSize) + '\\tab ' +
            escapeRtf(t.colSha256Short),
        );
        parts.push('\\b0\\par');

        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const shortHash = (att.sha256 || '').substring(0, 16) + '...';
            const displayName = truncateFilename(att.name);
            parts.push('\\pard\\ltrpar\\tx500\\tx4500\\tx5500\\tx6800\\sa60\\f0\\fs16');
            parts.push(
                `${i + 1}\\tab ${escapeRtf(displayName)}\\tab ${escapeRtf((att.ext || '').toUpperCase())}\\tab ${escapeRtf(formatBytes(att.size))}\\tab ${escapeRtf(shortHash)}`,
            );
            parts.push('\\par');
        }

        parts.push('\\pard\\ltrpar\\sb300\\sa100\\f0\\fs18\\b');
        parts.push(escapeRtf(t.fullSha256));
        parts.push('\\b0\\par');

        for (const att of attachments) {
            parts.push(`\\pard\\ltrpar\\sa40\\f0\\fs14 ${escapeRtf(att.name + ':')}\\par`);
            parts.push(`\\pard\\ltrpar\\li400\\sa80\\f0\\fs12 ${escapeRtf(att.sha256 || '')}\\par`);
        }
    }

    parts.push('}');
    return parts.join('\r\n');
}

// ═══════════════════════════════════════════════════════════════
// DOCX（手写最小 OOXML）
// ═══════════════════════════════════════════════════════════════

function xmlEscape(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** XML 1.0 非法控制字符剔除（防 Word 打不开） */
function xmlClean(s: string): string {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

const EMU_PER_PX = 9525;   // 96 DPI → EMU（docx 库同系数）

function paraProps(spacing: { before?: number; after?: number }, align: 'center' | null, tabs: number[] | null, indentLeft: number | null): string {
    const inner: string[] = [];
    if (tabs && tabs.length) {
        inner.push('<w:tabs>' + tabs.map((p) => `<w:tab w:val="left" w:pos="${p}"/>`).join('') + '</w:tabs>');
    }
    if (indentLeft != null) { inner.push(`<w:ind w:left="${indentLeft}"/>`); }
    const spAttrs: string[] = [];
    if (spacing.before != null) { spAttrs.push(`w:before="${spacing.before}"`); }
    if (spacing.after != null) { spAttrs.push(`w:after="${spacing.after}"`); }
    if (spAttrs.length) { inner.push(`<w:spacing ${spAttrs.join(' ')}/>`); }
    if (align === 'center') { inner.push('<w:jc w:val="center"/>'); }
    return inner.length ? `<w:pPr>${inner.join('')}</w:pPr>` : '';
}

function runProps(size: number, bold: boolean): string {
    return `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${bold ? '<w:b/>' : ''}</w:rPr>`;
}

function run(text: string, size: number, bold = false): string {
    return `<w:r>${runProps(size, bold)}<w:t xml:space="preserve">${xmlEscape(xmlClean(text))}</w:t></w:r>`;
}

function runTab(size: number, bold = false): string {
    return `<w:r>${runProps(size, bold)}<w:tab/></w:r>`;
}

function para(runsXml: string, spacing: { before?: number; after?: number }, align: 'center' | null = null, tabs: number[] | null = null, indentLeft: number | null = null): string {
    return `<w:p>${paraProps(spacing, align, tabs, indentLeft)}${runsXml}</w:p>`;
}

/** 内联图片段落（DrawingML） */
function imagePara(pngBufferIndex: number, rId: string, displayW: number, displayH: number, spacingAfter: number): string {
    const cx = Math.round(displayW * EMU_PER_PX);
    const cy = Math.round(displayH * EMU_PER_PX);
    const n = pngBufferIndex;
    const drawing =
        '<w:r><w:drawing>' +
        '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
        `<wp:extent cx="${cx}" cy="${cy}"/>` +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
        `<wp:docPr id="${n}" name="Picture ${n}"/>` +
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        `<pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/>' + `<a:ext cx="${cx}" cy="${cy}"/>` + '</a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic>' +
        '</wp:inline></w:drawing></w:r>';
    return para(drawing, { after: spacingAfter });
}

export interface DocxParts {
    contentTypes: Buffer;
    rels: Buffer;
    documentRels: Buffer;
    documentXml: Buffer;
    coreXml: Buffer;
    images: Buffer[];
}

/** 老 generateDocxDocument 版式移植（标题/正文/图片/附件索引；A4 内容宽 600px 上限） */
export function buildDocxParts(elements: ExportElement[], attachments: AttachmentEntry[], title: string, t: ExportTexts): DocxParts {
    const PAGE_CONTENT_WIDTH_PX = 600;
    const body: string[] = [];
    const images: Buffer[] = [];

    if (title) {
        body.push(para(run(title, 36, true), { before: 200, after: 400 }, 'center'));
    }

    for (const elem of elements) {
        if (elem.type === 'text') {
            const lines = elem.content.split(/\r?\n/);
            for (const line of lines) {
                body.push(para(run(line, 22), { after: 0 }));
            }
        } else if (elem.type === 'image') {
            if (elem.originalMark) {
                body.push(para(run(elem.originalMark, 22), { before: 200, after: 100 }));
            }
            const dispW = Math.min(elem.width, PAGE_CONTENT_WIDTH_PX);
            const dispH = Math.round(dispW * (elem.height / elem.width));
            const idx = images.length + 1;
            images.push(elem.pngBuffer);
            body.push(imagePara(idx, `rIdImg${idx}`, dispW, dispH, 200));
        } else if (elem.type === 'image_error') {
            body.push(para(run(`[${t.mediaConversionFailed(elem.path)}]`, 22), { after: 0 }));
        }
    }

    if (attachments.length > 0) {
        body.push(para(run('─'.repeat(31), 22), { before: 600, after: 200 }));
        body.push(para(run(t.attachmentIndex, 28, true), { before: 200, after: 200 }));
        body.push(para(
            run(t.colIndex, 18, true) + runTab(18) + run(t.colFileName, 18, true) + runTab(18) +
            run(t.colType, 18, true) + runTab(18) + run(t.colSize, 18, true) + runTab(18) + run(t.colSha256Short, 18, true),
            { after: 100 }, null, TAB_POS,
        ));

        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const shortHash = (att.sha256 || '').substring(0, 16) + '...';
            const displayName = truncateFilename(att.name);
            body.push(para(
                run(String(i + 1), 16) + runTab(16) + run(displayName, 16) + runTab(16) +
                run((att.ext || '').toUpperCase(), 16) + runTab(16) + run(formatBytes(att.size), 16) + runTab(16) + run(shortHash, 16),
                { after: 60 }, null, TAB_POS,
            ));
        }

        body.push(para(run(t.fullSha256, 18, true), { before: 300, after: 100 }));
        for (const att of attachments) {
            body.push(para(run(`${att.name}:`, 14), { after: 40 }));
            body.push(para(run(att.sha256 || '', 12), { after: 80 }, null, null, 432));
        }
    }

    const docXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
        '<w:body>' + body.join('') +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
        '<w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>' +
        '</w:body></w:document>';

    const relsXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>';

    let documentRels =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for (let i = 1; i <= images.length; i++) {
        documentRels += `<Relationship Id="rIdImg${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i}.png"/>`;
    }
    documentRels += '</Relationships>';

    const contentTypes =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>';

    const coreXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${xmlEscape(xmlClean(title || ''))}</dc:title>` +
        '<dc:creator>qqqide</dc:creator><cp:lastModifiedBy>qqqide</cp:lastModifiedBy>' +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>` +
        '</cp:coreProperties>';

    return {
        contentTypes: Buffer.from(contentTypes, 'utf8'),
        rels: Buffer.from(relsXml, 'utf8'),
        documentRels: Buffer.from(documentRels, 'utf8'),
        documentXml: Buffer.from(docXml, 'utf8'),
        coreXml: Buffer.from(coreXml, 'utf8'),
        images,
    };
}

/** DOCX 打包（ZipWriter，deflate 9） */
export async function writeDocx(outPath: string, parts: DocxParts): Promise<void> {
    const zip = new ZipWriter(outPath);
    await zip.open();
    await zip.addBuffer('[Content_Types].xml', parts.contentTypes);
    await zip.addBuffer('_rels/.rels', parts.rels);
    await zip.addBuffer('word/document.xml', parts.documentXml);
    await zip.addBuffer('word/_rels/document.xml.rels', parts.documentRels);
    await zip.addBuffer('docProps/core.xml', parts.coreXml);
    for (let i = 0; i < parts.images.length; i++) {
        await zip.addBuffer(`word/media/image${i + 1}.png`, parts.images[i]);
    }
    await zip.finalize();
}
