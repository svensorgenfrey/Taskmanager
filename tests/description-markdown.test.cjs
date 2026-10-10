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
