import { describe, test, expect, jest } from '@jest/globals';
import { Converter, showdownShim } from '../public/scripts/showdown-shim.js';

describe('showdown compatibility shim', () => {
    test('Converter.makeHtml basic markdown rendering', () => {
        const converter = new Converter();
        const html = converter.makeHtml('# Hello World').trim();
        expect(html).toBe('<h1>Hello World</h1>');
    });

    test('Converter.makeHtml table rendering', () => {
        const converter = new Converter();
        const md = '| A | B |\n|---|---|\n| 1 | 2 |';
        const html = converter.makeHtml(md).trim();
        expect(html).toContain('<table>');
        expect(html).toContain('<td>1</td>');
    });

    test('Converter.setOption and getOption works without throwing', () => {
        const converter = new Converter();
        converter.setOption('tables', true);
        expect(converter.getOption('tables')).toBe(true);
        expect(converter.getOptions().tables).toBe(true);
    });

    test('Converter.addExtension with lang extension (filter)', () => {
        const converter = new Converter();
        converter.addExtension({
            type: 'lang',
            filter: (text) => text.replace(/foo/g, 'bar'),
        });
        const html = converter.makeHtml('foo').trim();
        expect(html).toBe('<p>bar</p>');
    });

    test('Converter.addExtension with output extension (replace)', () => {
        const converter = new Converter();
        converter.addExtension({
            type: 'output',
            regex: /bar/g,
            replace: 'baz',
        });
        const html = converter.makeHtml('bar').trim();
        expect(html).toBe('<p>baz</p>');
    });

    test('showdownShim top-level methods do not throw', () => {
        expect(() => showdownShim.setOption('test', 123)).not.toThrow();
        expect(() => showdownShim.getOption('test')).not.toThrow();
        expect(() => showdownShim.getOptions()).not.toThrow();
        expect(() => showdownShim.getDefaultOptions()).not.toThrow();
        expect(() => showdownShim.extension('test', () => {})).not.toThrow();
        expect(() => showdownShim.subParser('unhashHTMLSpans', () => {})).not.toThrow();
    });
});
