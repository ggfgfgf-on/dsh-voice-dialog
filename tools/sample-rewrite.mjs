
import { rewriteByRules } from '../lib/rewriter.js'
import { stripFillerHead } from '../lib/segmenter.js'
const input = { spoken: '好，我检查一下构建。', pending: [
  { text: '构建是通过了', sentenceId: 1 }, { text: '构建是通过了', sentenceId: 1 },
  { text: '另外顺便说一句我换了键盘', sentenceId: 2 }, { text: '但启动还是慢', sentenceId: 3 },
] }
console.log('before:', input.spoken + ' | ' + input.pending.map((b) => b.text).join(' | '))
console.log('after :', JSON.stringify(rewriteByRules(input).lines))
console.log('strip1:', stripFillerHead('好，我们先把队列修了'))
console.log('strip2:', stripFillerHead('稍等，我先看一下日志里写了什么'))
console.log('strip3:', stripFillerHead('对'))
