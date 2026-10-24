import { describe, test, expect } from '@jest/globals';
import { Marked } from 'marked';
import { markedUnderlineExt, markedImgDimensionsExt, markdownSpaceParityExt } from '../public/scripts/marked-extensions.js';
import { markdownUnderscoreExt } from '../public/scripts/marked-underscore.js';

function buildMarkedInstance() {
    const marked = new Marked({
        breaks: true,
        gfm: true,
    });
    marked.use({
        extensions: [
            markedUnderlineExt(),
            markedImgDimensionsExt(),
            markdownUnderscoreExt(),
        ],
    });
    marked.use(markdownSpaceParityExt());
    return marked;
}

describe('marked parity with showdown corpus', () => {
    const marked = buildMarkedInstance();

    test('renders headers and strikethrough', () => {
        const md = '# Title\n~~strikethrough~~';
        const html = marked.parse(md).trim();
        expect(html).toContain('<h1>Title</h1>');
        expect(html).toContain('<del>strikethrough</del>');
    });

    test('renders tables', () => {
        const md = '| Col 1 | Col 2 |\n|---|---|\n| val 1 | val 2 |';
        const html = marked.parse(md).trim();
        expect(html).toContain('<table>');
        expect(html).toContain('<th>Col 1</th>');
        expect(html).toContain('<td>val 1</td>');
    });

    test('renders underline with __', () => {
        const md = '__underlined text__';
        const html = marked.parse(md).trim();
        expect(html).toBe('<p><u>underlined text</u></p>');
    });

    test('renders italic with _', () => {
        const md = '_italic text_';
        const html = marked.parse(md).trim();
        expect(html).toBe('<p><em>italic text</em></p>');
    });

    test('preserves mid-word underscores', () => {
        const md = 'some_variable_name and another_one';
        const html = marked.parse(md).trim();
        expect(html).toBe('<p>some_variable_name and another_one</p>');
    });

    test('renders images with dimensions =WxH', () => {
        const md = '![alt text](https://example.com/image.png =100x200)';
        const html = marked.parse(md).trim();
        expect(html).toContain('width="100"');
        expect(html).toContain('height="200"');
    });

    test('renders images with dimensions =Wx* and =*xH', () => {
        const md1 = '![alt text](https://example.com/image.png =100x*)';
        expect(marked.parse(md1).trim()).toContain('width="100" height="auto"');
        const md2 = '![alt text](https://example.com/image.png =*x200)';
        expect(marked.parse(md2).trim()).toContain('width="auto" height="200"');
    });

    test('renders nested spans without destruction', () => {
        const md = '<span>outer <span>inner</span></span>';
        const html = marked.parse(md).trim();
        expect(html).toBe('<p><span>outer <span>inner</span></span></p>');
    });

    test('renders fenced code blocks', () => {
        const md = '```javascript\nconsole.log("hello");\n```';
        const html = marked.parse(md).trim();
        expect(html).toContain('console.log(&quot;hello&quot;);');
    });

    test('renders task lists', () => {
        const md = '- [ ] todo\n- [x] done';
        const html = marked.parse(md).trim();
        expect(html).toContain('type="checkbox"');
        expect(html).toContain('todo');
        expect(html).toContain('done');
    });

    test('renders images with whitespace between ] and ( (showdown parity)', () => {
        const md = '![] (https://cdn.example.com/files/a61a6295898f.png)';
        const html = marked.parse(md).trim();
        expect(html).toContain('<img src="https://cdn.example.com/files/a61a6295898f.png"');
        expect(html).not.toContain('![] (');
    });

    test('renders image dimensions with whitespace between ] and (', () => {
        const md = '![alt text] (https://example.com/image.png =100x200)';
        const html = marked.parse(md).trim();
        expect(html).toContain('width="100"');
        expect(html).toContain('height="200"');
    });

    test('renders links with whitespace between ] and (', () => {
        const md = '[text] (https://example.com)';
        const html = marked.parse(md).trim();
        expect(html).toBe('<p><a href="https://example.com">text</a></p>');
    });

    test('does not rewrite whitespace inside inline code', () => {
        const md = '`![] (https://example.com/image.png)`';
        const html = marked.parse(md).trim();
        expect(html).toBe('<p><code>![] (https://example.com/image.png)</code></p>');
    });

    test('does not rewrite whitespace inside fenced code blocks', () => {
        const md = '```\n![] (https://example.com/image.png)\n```';
        const html = marked.parse(md).trim();
        expect(html).toContain('![] (https://example.com/image.png)');
        expect(html).not.toContain('<img');
    });

    test('still renders the no-whitespace form', () => {
        const md = '![alt text](https://example.com/image.png)';
        const html = marked.parse(md).trim();
        expect(html).toBe('<p><img src="https://example.com/image.png" alt="alt text"></p>');
    });
});
