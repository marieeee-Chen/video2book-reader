import assert from 'node:assert/strict'
import { imageUrl } from '../packages/reader/src/markdown/image-url.ts'
const page = 'http://localhost/reader/#/v/example'
const document = '/courses/embedded/test/textbooks/chapter.md'
assert.equal(imageUrl('assets/image.png', document, page), 'http://localhost/courses/embedded/test/textbooks/assets/image.png')
assert.equal(imageUrl('../assets/image.png', document, page), 'http://localhost/courses/embedded/test/assets/image.png')
assert.equal(imageUrl('https://example.org/image.png', document, page), 'https://example.org/image.png')
assert.equal(imageUrl('javascript:alert(1)', document, page), undefined)
assert.equal(imageUrl('file:///etc/passwd', document, page), undefined)
assert.equal(imageUrl('assets/image.png', undefined, page), undefined)
console.log('Document image URL checks passed')
