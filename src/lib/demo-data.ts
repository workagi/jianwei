export type DemoPlatform = "x" | "wechat" | "web_search";
export interface DemoItem { id:string; platform:DemoPlatform; source:string; handle?:string; time:string; title:string; excerpt:string; tags:string[]; score:number; match:string; }

export const hotTopics = [
  { title:"Agent 产品开始从对话转向后台执行", count:7 }, { title:"国产大模型推理成本继续下降", count:5 },
  { title:"AI 搜索产品竞争进入数据源阶段", count:4 }, { title:"微信公众号内容资产再利用", count:3 },
];

export const demoItems: DemoItem[] = [
  { id:"x-1",platform:"x",source:"示例研究员",handle:"@example_researcher",time:"10:18",title:"智能体真正有价值的变化，是它开始在后台持续完成工作",excerpt:"新的产品形态不再要求用户守着对话窗口。任务会在后台继续，当需要决策时才把问题推回来，这会改变知识工作的交互方式。",tags:["智能体","产品趋势"],score:82,match:"命中：AI Agent" },
  { id:"wx-1",platform:"wechat",source:"示例科技观察",time:"09:46",title:"我们正在把 AI 工具从一次性使用，变成一套长期工作的系统",excerpt:"文章讨论了为什么真正有价值的 AI 产品不是多一个聊天框，而是能够承接上下文、持续运行并给出可检查交付物的工作台。",tags:["公众号","AI 工作流"],score:76,match:"订阅账号" },
  { id:"web-1",platform:"web_search",source:"示例科技媒体",time:"09:21",title:"AI 信息服务正在比拼来源质量，而不只是答案长度",excerpt:"随着 AI 摘要成本下降，真正形成差异的将是信息源覆盖、更新速度、可追溯性以及面向个人的监控工作流。",tags:["全网搜索","行业动态"],score:71,match:"命中：AI 信息聚合" },
  { id:"x-2",platform:"x",source:"示例开发者",handle:"@example_builder",time:"08:57",title:"软件正在成为智能体可以持续操作的一层基础设施",excerpt:"智能体不仅会编写软件，越来越多的软件也开始允许智能体观察状态、执行动作并验证结果。",tags:["X / Twitter","软件工程"],score:69,match:"订阅账号" },
];

export const demoMonitors = [
  { platform:"x" as const,title:"@example_researcher",detail:"每 15 分钟 · 排除回复和转推",health:"正常",warning:false },
  { platform:"wechat" as const,title:"示例科技观察",detail:"每 60 分钟 · WeRSS",health:"待识别",warning:true },
  { platform:"web_search" as const,title:"AI 信息聚合",detail:"每 30 分钟 · 全网与新闻",health:"正常",warning:false },
];
