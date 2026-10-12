// Run with: node tests/description-markdown.test.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const escapeDeclaration=source.match(/  const esc=.*;\n/)[0];
const renderers=source.slice(source.indexOf('  function plainDescription('),source.indexOf('  function linkifyHtml('));
const context={};
vm.runInNewContext(escapeDeclaration+renderers+'\nthis.render=inlineMarkdown;this.plain=plainDescription;',context);
const listRenderers=source.slice(source.indexOf('  function listItemHtml('),source.indexOf('  function cardHtml('));
context.linkifyHtml=html=>html;
vm.runInNewContext(listRenderers+'\nthis.renderBlocks=markdownToHtml;',context);

test('a direct WebP URL renders as an image',()=>{
  assert.equal(context.render('![Foto](https://example.com/photo.webp)'),'<img src="https://example.com/photo.webp" alt="Foto" loading="lazy">');
});
test('an absolute local file URL renders as an image',()=>{
  const url='file:///home/sven/Bilder/Portrait_Sven_Sorgenfrey_300x400.jpg';
  assert.equal(context.render('![Portrait]('+url+')'),'<img src="'+url+'" alt="Portrait" loading="lazy">');
});
test('local file URLs preserve encoded spaces and Markdown-escaped parentheses',()=>{
  assert.equal(context.render(String.raw`![](file:///home/sven/Bilder/Mein%20Portrait_\(klein\).jpg)`),'<img src="file:///home/sven/Bilder/Mein%20Portrait_(klein).jpg" alt="" loading="lazy">');
});
test('non-image executable URL schemes do not produce image elements',()=>{
  assert(!context.render('![Foto](javascript:alert(1))').includes('<img'));
});
test('underscores in image URLs and alternative text remain literal',()=>{
  assert.equal(context.render('![my_photo_name](https://example.com/my_photo_name.webp)'),'<img src="https://example.com/my_photo_name.webp" alt="my_photo_name" loading="lazy">');
});
test('escaped parentheses from the EasyMDE URL dialog remain part of the image URL',()=>{
  const markdown=String.raw`![Foto](https://example.com/photo_\(large\)_file.webp)`;
  assert.equal(context.render(markdown),'<img src="https://example.com/photo_(large)_file.webp" alt="Foto" loading="lazy">');
  assert.equal(context.plain(markdown),'Foto');
});
test('query parameters are correctly escaped in HTML attributes',()=>{
  assert.equal(context.render('![](https://example.com/photo.webp?size=400&fit=crop)'),'<img src="https://example.com/photo.webp?size=400&amp;fit=crop" alt="" loading="lazy">');
});
test('image markup inside inline code stays code',()=>{
  assert.equal(context.render('`![](https://example.com/photo.webp)`'),'<code>![](https://example.com/photo.webp)</code>');
});
test('formatting around images still works',()=>{
  assert.equal(context.render('**Foto:** ![](https://example.com/a_b_c.webp) _Text_'),'<strong>Foto:</strong> <img src="https://example.com/a_b_c.webp" alt="" loading="lazy"> <em>Text</em>');
});
test('previously embedded image data remains renderable',()=>{
  assert.equal(context.render('![Foto](data:image/webp;base64,UklGRg==)'),'<img src="data:image/webp;base64,UklGRg==" alt="Foto" loading="lazy">');
});
test('link formatting does not change the link URL',()=>{
  assert.equal(context.render('[**Seite**](https://example.com/a_b_c)'),'<a href="https://example.com/a_b_c" target="_blank" rel="noopener noreferrer"><strong>Seite</strong></a>');
});
test('HTML in image labels and description text is escaped',()=>{
  const html=context.render('![" onerror="example](https://example.com/photo.webp) <script>example</script>');
  assert.equal(html,'<img src="https://example.com/photo.webp" alt="&quot; onerror=&quot;example" loading="lazy"> &lt;script&gt;example&lt;/script&gt;');
});

test('nested lists keep children inside their parent and return to previous levels',()=>{
  const markdown='- Parent\n    - Child\n        - Grandchild\n    - Second child\n- Sibling';
  assert.equal(context.renderBlocks(markdown),'<ul><li>Parent<ul><li>Child<ul><li>Grandchild</li></ul></li><li>Second child</li></ul></li><li>Sibling</li></ul>');
});
test('ordered and unordered lists can nest and preserve their starting number',()=>{
  const markdown='3. Parent\n    - Child\n        2. Grandchild\n4. Sibling';
  assert.equal(context.renderBlocks(markdown),'<ol start="3"><li>Parent<ul><li>Child<ol start="2"><li>Grandchild</li></ol></li></ul></li><li>Sibling</li></ol>');
});
test('tabs and mixed leading whitespace use four-space tab stops',()=>{
  const spaces='- Parent\n    - Child\n        - Grandchild\n    - Second child';
  const tabs='- Parent\n\t- Child\n\t\t- Grandchild\n  \t- Second child';
  assert.equal(context.renderBlocks(tabs),context.renderBlocks(spaces));
});
test('blank lines preserve nesting and original checkbox line numbers',()=>{
  const html=context.renderBlocks('- [ ] Parent\n\n\t- [x] Child\n\n- Sibling');
  assert.match(html,/<div class="checklist-content">Parent<ul><li class="checklist-item">/);
  assert.match(html,/data-checklist-line="0"/);
  assert.match(html,/data-checklist-line="2"[^>]*checked/);
  assert.match(html,/<\/div><\/li><\/ul><\/div><\/li><li>Sibling<\/li><\/ul>$/);
});
test('list type changes and following blocks close every nested item',()=>{
  const html=context.renderBlocks('- Parent\n    - Bullet\n    1. Number\n\n# Heading\nText');
  assert.equal(html,'<ul><li>Parent<ul><li>Bullet</li></ul><ol><li>Number</li></ol></li></ul><h1>Heading</h1><p>Text</p>');
});
test('indented continuation text stays with its list item and HTML stays escaped',()=>{
  const html=context.renderBlocks('- Parent\n    Continuation\n    - <script>example</script>');
  assert.equal(html,'<ul><li>Parent<br>Continuation<ul><li>&lt;script&gt;example&lt;/script&gt;</li></ul></li></ul>');
});
