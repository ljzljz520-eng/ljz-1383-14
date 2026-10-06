# 个人创意主页 - 技术说明文档

本项目是一个现代化的个人主页系统，采用 3 级页面架构，旨在展示个人的技术见解、兴趣爱好及专业作品。

## 项目特点

1.  **现代化视觉设计**：采用流行的 "Glassmorphism" (毛玻璃) 风格，结合动态渐变背景和丝滑的微动画，提供极佳的视觉体验。
2.  **3 级导航结构**：
    *   **Level 1**: 首页 (`index.html`) - 整体概览。
    *   **Level 2**: 列表页 (`hobbies.html`, `portfolio.html`, `contact.html`) - 分类展示。
    *   **Level 3**: 详情页 (`hobby-detail.html`, `work-detail.html`) - 深度内容。
3.  **自定义交互系统**：弃用原生 `alert`，开发了基于 Vanilla JS 的 Toast 通知系统，用于表单验证反馈和交互提示。
4.  **纯净技术栈**：仅使用 HTML5, CSS3 和原生 JavaScript，无需任何外部框架。

## 文件结构

- `index.html`: 入口首页
- `hobbies.html`: 兴趣爱好列表 (L2)
- `hobby-detail.html`: 摄影兴趣详情 (L3)
- `portfolio.html`: 作品集列表 (L2)
- `work-detail.html`: Neo-Finance 应用案例 (L3)
- `contact.html`: 联系表单页 (L2)
- `css/style.css`: 全局样式表
- `js/main.js`: 交互逻辑与表单验证
- `images/`: 项目多媒体资源

## 技术要点

- **CSS 选择器**：广泛使用伪类 (`:hover`, `:focus`), 子选择器及复杂层叠关系。
- **盒模型布局**：利用 Flexbox 和 CSS Grid 实现响应式布局。
- **表单验证**：实时检测用户输入，并通过自定义 UI 组件进行错误提示。
