# Markdown 功能演示

> 这是一个通用的 Markdown 演示文档，覆盖常见的 Markdown 语法、GFM 扩展与图表功能，可用于测试任何 Markdown 渲染工具的输出是否符合预期。

---

## 📊 表格支持

| 功能 | 状态 | 说明 |
|------|------|------|
| 标准 Markdown | ✅ | 标题、列表、链接、图片等 |
| GFM 表格 | ✅ | 表头、对齐、单元格内嵌 |
| Mermaid 图表 | ✅ | 流程图、时序图、甘特图、饼图等 |
| 代码高亮 | ✅ | 多种编程语言 |
| 数学公式 | ✅ | 行内、块级；定界符风格有两种，均属 LaTeX 数学语法：美元符 `$...$`/`$$...$$` 与括号 `\(...\)`/`\[...\]` |
| 任务列表 | ✅ | GFM 风格勾选框 |

## ✅ 任务列表

- [x] 已完成项示例
- [x] 另一项已完成
- [ ] 待办项示例
- [ ] 另一项待办

## 📐 数学公式

以下覆盖几种常见写法；不同渲染工具支持的语法子集可能不同。

**货币 / 非公式边界测试：**

- 我买了苹果花了$5又买了橘子花了$10。
- 我买了苹果花了 $5 又买了橘子花了 $10 。

**行内公式（美元符）：** $E = mc^2$

**行内公式（LaTeX 括号）：** \(E = mc^2\)

**行内公式（美元符 + 内侧空格）：** $ E = mc^2 $

**行内公式（美元符 + 数字边界）：** $5^2 = 25$

**块级公式：**

$$
\int_{0}^{\infty} e^{-x^2} \, dx = \frac{\sqrt{\pi}}{2}
$$

**矩阵：**

$$
\begin{bmatrix}
a & b \\
c & d
\end{bmatrix}
\begin{bmatrix}
x \\
y
\end{bmatrix}
=
\begin{bmatrix}
ax + by \\
cx + dy
\end{bmatrix}
$$

## 🔷 Mermaid 流程图

```mermaid
graph TD
    A[Markdown 源] --> B{解析器}
    B --> C[HTML 输出]
    C --> D[浏览器查看]
    D --> E[打印 / 分享]
```

## 🔷 Mermaid 时序图

```mermaid
sequenceDiagram
    participant U as 用户
    participant T as 工具
    participant B as 浏览器

    U->>T: tool doc.md -o doc.html
    T->>T: 解析 Markdown
    T->>T: 渲染图表与代码
    T->>T: 处理数学公式
    T->>B: 输出 HTML
    B->>U: 显示结果
```

## 🔷 Mermaid 甘特图

```mermaid
gantt
    title 项目计划
    dateFormat  YYYY-MM-DD
    section 设计
    需求分析     :done, a1, 2026-06-01, 3d
    原型设计     :active, a2, 2026-06-04, 4d
    section 开发
    核心功能     :b1, 2026-06-08, 7d
    测试修复     :b2, 2026-06-15, 5d
    section 发布
    Beta 发布    :c1, 2026-06-20, 1d
```

## 🔷 Mermaid 饼图

```mermaid
pie title 编程语言使用分布
    "Python" : 42
    "JavaScript" : 28
    "Go" : 15
    "Rust" : 10
    "其他" : 5
```

## 💻 代码高亮演示

### Python

```python
import asyncio
from dataclasses import dataclass
from typing import Optional

@dataclass
class Task:
    """一个简单的任务类"""
    name: str
    priority: int = 0
    done: bool = False

    def complete(self) -> None:
        self.done = True

async def process_tasks(tasks: list[Task]) -> list[str]:
    """异步处理任务列表"""
    results = []
    for task in sorted(tasks, key=lambda t: -t.priority):
        await asyncio.sleep(0.1)
        task.complete()
        results.append(f"✅ {task.name}")
    return results
```

### JavaScript

```javascript
// 防抖函数
function debounce(fn, delay = 300) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// 使用示例
const searchInput = document.querySelector('#search');
searchInput.addEventListener('input', debounce(async (e) => {
  const results = await fetch(`/api/search?q=${e.target.value}`);
  renderResults(await results.json());
}, 500));
```

### SQL

```sql
-- 用户活跃度统计
SELECT
    DATE(created_at) AS date,
    COUNT(DISTINCT user_id) AS active_users,
    COUNT(*) AS total_actions,
    ROUND(COUNT(*) * 1.0 / COUNT(DISTINCT user_id), 2) AS avg_actions_per_user
FROM user_actions
WHERE created_at >= DATE('now', '-30 days')
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### Shell

```bash
#!/bin/bash
# 批量处理 Markdown 文件
TOOL="markdown-tool"

for file in docs/*.md; do
    name=$(basename "$file" .md)
    echo "处理: $file → output/${name}.html"
    $TOOL "$file" -o "output/${name}.html"
done

echo "✅ 全部完成！"
```

## 📝 引用块

> "优秀的工具应该让复杂的事情变简单，而不是让简单的事情变复杂。"
>
> — 设计哲学

### 多层嵌套引用

> 第一层引用
>> 第二层引用
>>> 第三层引用 — 深层次的思考

## 🎯 提示块（Admonitions）

!!! note "注意"
    一些 Markdown 工具支持 `!!! type "标题"` 形式的提示块，可自定义标题。

!!! warning "警告"
    不同工具支持的语法子集不尽相同，使用前请参考对应工具的文档。

!!! tip "提示"
    许多 Markdown 工具支持深色模式与自定义主题。

!!! info "信息"
    Mermaid 图表语法由支持该扩展的工具渲染，是否需要联网取决于具体实现。

## 📋 定义列表

Markdown
:: 一种轻量级标记语言，由 John Gruber 创建

HTML
:: 超文本标记语言，用于创建网页的标准语言

CSS
:: 层叠样式表，用于描述 HTML 文档的外观

## 🔗 缩写支持

HTML 是 Web 的基础。CSS 负责样式，JS 负责交互。

*[HTML]: HyperText Markup Language
*[CSS]: Cascading Style Sheets
*[JS]: JavaScript

## 📸 图片

![占位图](https://via.placeholder.com/600x200/0366d6/ffffff?text=Markdown+Demo)

---

**Happy Coding! 🎉**
