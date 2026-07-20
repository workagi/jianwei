export type DemoPlatform = "x" | "wechat" | "web_search";
export interface DemoItem { id:string; platform:DemoPlatform; source:string; handle?:string; time:string; title:string; excerpt:string; tags:string[]; score:number; match:string; }

export const hotTopics = [
  { title:"Agent 产品开始从对话转向后台执行", count:7 }, { title:"国产大模型推理成本继续下降", count:5 },
  { title:"AI 搜索产品竞争进入数据源阶段", count:4 }, { title:"微信公众号内容资产再利用", count:3 },
];

export const demoItems: DemoItem[] = [
  { id:"x-1",platform:"x",source:"Ethan Mollick",handle:"@emollick",time:"10:18",title:"智能体真正有价值的变化，是它开始在后台持续完成工作",excerpt:"新的产品形态不再要求用户守着对话窗口。任务会在后台继续，当需要决策时才把问题推回来，这会改变知识工作的交互方式。",tags:["智能体","产品趋势"],score:82,match:"命中：AI Agent" },
  { id:"wx-1",platform:"wechat",source:"数字生命卡兹克",time:"09:46",title:"我们正在把 AI 工具从一次性使用，变成一套长期工作的系统",excerpt:"文章讨论了为什么真正有价值的 AI 产品不是多一个聊天框，而是能够承接上下文、持续运行并给出可检查交付物的工作台。",tags:["公众号","AI 工作流"],score:76,match:"订阅账号" },
  { id:"web-1",platform:"web_search",source:"TechCrunch",time:"09:21",title:"AI information services compete on source quality, not answer length",excerpt:"As AI summaries become cheaper, differentiated products are investing in source coverage, freshness, traceability and private monitoring workflows.",tags:["全网搜索","行业动态"],score:71,match:"命中：AI 信息聚合" },
  { id:"x-2",platform:"x",source:"Andrej Karpathy",handle:"@karpathy",time:"08:57",title:"Software is becoming a layer that agents can continuously operate",excerpt:"A useful mental model is not just that agents write software, but that more software is being designed so agents can observe state, take actions and verify outcomes.",tags:["X / Twitter","软件工程"],score:69,match:"订阅账号" },
];

export const demoMonitors = [
  { platform:"x" as const,title:"@emollick",detail:"每 15 分钟 · 排除回复和转推",health:"正常",warning:false },
  { platform:"wechat" as const,title:"数字生命卡兹克",detail:"每 60 分钟 · WeRSS",health:"待识别",warning:true },
  { platform:"web_search" as const,title:"AI 信息聚合",detail:"每 30 分钟 · 全网与新闻",health:"正常",warning:false },
];
