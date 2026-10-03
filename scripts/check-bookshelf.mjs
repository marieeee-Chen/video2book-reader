import assert from 'node:assert/strict'
import { buildCategoryTree, categoryContainsCourse, collectBranchIds, countCategory, findCategoryAncestors, groupCourses, isCategoryInPath, isReadableCourse } from '../packages/reader/src/content/category-tree.ts'

const categories = [
  { id: 'computer', name: '计算机' },
  { id: 'computer.programming', name: '编程语言' },
  { id: 'computer.ai', name: '人工智能' },
  { id: 'computer.ai.nlp', name: '自然语言处理' },
  { id: 'math', name: '数学' },
  { id: 'math.calculus', name: '微积分' },
  { id: 'unmapped', name: '未映射分类' },
]
const courses = [
  { id: 'python', title: 'Python', direction: '', volumeCount: 2, noteCount: 1, subtitleCount: 3, categoryPaths: ['computer.programming', 'computer.ai'] },
  { id: 'nlp', title: 'NLP', direction: '', volumeCount: 1, noteCount: 1, subtitleCount: 2, categoryPaths: ['computer.ai.nlp'] },
  { id: 'math', title: '数学', direction: '', volumeCount: 3, noteCount: 2, subtitleCount: 0, categoryPaths: ['math.calculus'] },
  { id: 'legacy', title: '旧课程', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0 },
]

const tree = buildCategoryTree(categories)
assert.deepEqual(tree.map((node) => node.id), ['computer', 'math', 'unmapped'])
assert.deepEqual(tree[0].children.map((node) => node.id), ['computer.programming', 'computer.ai'])
assert.deepEqual(tree[0].children[1].children.map((node) => node.id), ['computer.ai.nlp'])
assert.equal(countCategory(courses, 'computer'), 2)
assert.equal(countCategory(courses, 'computer.ai'), 2)
assert.equal(categoryContainsCourse(courses[0], 'computer'), true)
assert.equal(categoryContainsCourse(courses[0], 'computer.ai.nlp'), false)

const allGroups = groupCourses(courses, null, categories)
assert.deepEqual(allGroups.map((group) => group.id), ['computer.programming', 'computer.ai.nlp', 'math.calculus', '__uncategorized__'])
assert.equal(allGroups.flatMap((group) => group.courses).length, courses.length)
assert.equal(new Set(allGroups.flatMap((group) => group.courses.map((course) => course.id))).size, courses.length)

const aiGroups = groupCourses(courses, 'computer.ai', categories)
assert.deepEqual(aiGroups.map((group) => group.id), ['computer.ai', 'computer.ai.nlp'])
assert.equal(aiGroups.flatMap((group) => group.courses).length, 2)

assert.deepEqual(collectBranchIds(tree), ['computer', 'computer.ai', 'math'])
assert.deepEqual(findCategoryAncestors(tree, 'computer.ai.nlp'), ['computer', 'computer.ai'])
assert.deepEqual(findCategoryAncestors(tree, 'unmapped'), [])
assert.equal(isCategoryInPath(tree, 'computer', 'computer.ai.nlp'), true)
assert.equal(isCategoryInPath(tree, 'math', 'computer.ai.nlp'), false)
assert.equal(isCategoryInPath(tree, 'computer.ai.nlp', null), false)

// —— 组序跟随分类树 DFS,而非 categories 数组序(上游会在数组尾部追加子分类) ——
const tailCategories = [
  { id: 'computer', name: '计算机' },
  { id: 'math.calculus', name: '微积分' }, // 数组序靠前,树序在 math 之下
  { id: 'computer.programming', name: '编程语言' },
  { id: 'math', name: '数学' },
  { id: 'computer.ai', name: '人工智能' },
  { id: 'computer.ai.nlp', name: '自然语言处理' }, // 数组尾部追加(上游常见)
  { id: 'law.criminal', name: '刑法' }, // 父分类缺失 → 降级为根;无课不产生组
]
const tailCourses = [
  { id: 'calc', title: '微积分', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0, categoryPaths: ['math.calculus'] },
  { id: 'prog', title: '编程', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0, categoryPaths: ['computer.programming'] },
  { id: 'root', title: '导论', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0, categoryPaths: ['computer'] }, // 直挂父分类 → 父成组
  { id: 'nlp', title: 'NLP', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0, categoryPaths: ['computer.ai.nlp'] },
  { id: 'ghost', title: '未知线课', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0, categoryPaths: ['未知线'] }, // 未知路径组
  { id: 'legacy2', title: '旧课', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0 }, // 无路径
]
const tailGroups = groupCourses(tailCourses, null, tailCategories)
const tailIds = tailGroups.map((group) => group.id)
// 已知组 = 树 DFS 序的子序列(computer → computer.programming → computer.ai.nlp → math.calculus);
// 没有课程被分配到的节点(law.criminal)不产生组;课程直接归属的父分类(computer)也产生组
assert.deepEqual(tailIds.slice(0, 4), ['computer', 'computer.programming', 'computer.ai.nlp', 'math.calculus'])
// 未知路径组与未分类都落在已知组之后(彼此相对序依赖 locale 实现,不断言)
assert.deepEqual(new Set(tailIds.slice(4)), new Set(['未知线', '__uncategorized__']))
const tailComputerView = groupCourses(tailCourses, 'computer', tailCategories)
assert.deepEqual(tailComputerView.map((group) => group.id), ['computer', 'computer.programming', 'computer.ai.nlp'])

// 同长度匹配路径:保留原路径顺序(取第一条匹配)
const twinCategories = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
]
const twinCourse = { id: 'twin', title: '双挂', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0, categoryPaths: ['b', 'a'] }
assert.equal(groupCourses([twinCourse], null, twinCategories)[0].id, 'b')

// —— 只看可读:谓词与过滤语义 ——
assert.equal(isReadableCourse({ volumeCount: 0, noteCount: 0 }), false)
assert.equal(isReadableCourse({ volumeCount: 0, noteCount: 1 }), true) // 仅笔记也算可读
assert.equal(isReadableCourse({ volumeCount: 2, noteCount: 0 }), true)
// 纯逐字稿语料卡全被滤 → 不产生组(书架层显示"过滤空态"而非"没有课程")
const corpusOnlyCategories = [{ id: 'self.corpus', name: '语料' }]
const corpusOnly = [
  { id: 'c1', title: '语料1', direction: '', volumeCount: 0, noteCount: 0, subtitleCount: 5, categoryPaths: ['self.corpus'] },
  { id: 'c2', title: '语料2', direction: '', volumeCount: 0, noteCount: 0, subtitleCount: 3, categoryPaths: ['self.corpus'] },
]
assert.equal(groupCourses(corpusOnly.filter(isReadableCourse), null, corpusOnlyCategories).length, 0)

console.log('bookshelf check passed')
