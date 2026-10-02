import { db } from "@/db";
import { sql } from "drizzle-orm";
import { modelDailyRequestLimit } from "@/lib/model-receipts";

export async function AdminModelUsage() {
  if (!process.env.DATABASE_URL) return null;
  let stats: { today: number; unknown: number; input: number; output: number; unknownCost: number; cost: number };
  try {
    const rows = await db.execute<typeof stats>(sql`
      select count(*)::int as today,
        count(*) filter (where status in ('unknown', 'sending'))::int as unknown,
        coalesce(sum(input_tokens), 0)::int as input,
        coalesce(sum(output_tokens), 0)::int as output,
        count(*) filter (where estimated_cost is null)::int as "unknownCost",
        coalesce(sum(estimated_cost), 0)::float as cost
      from model_attempts
      where started_at >= date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'
    `);
    stats = rows[0];
  } catch {
    return <section className="credentials-card"><h2>模型用量</h2><p>暂时无法读取模型用量，请检查数据库连接与版本升级状态。</p></section>;
  }
  return <section className="credentials-card">
    <h2>模型用量</h2>
    <p>今日请求尝试 {stats.today} / {modelDailyRequestLimit()} 次，包含采集分析、补跑和标题翻译。复用已保存结果不占新增额度。</p>
    <p>输入 {stats.input.toLocaleString()} tokens · 输出 {stats.output.toLocaleString()} tokens</p>
    <p>{stats.unknownCost > 0 ? `已知部分估算 $${Number(stats.cost).toFixed(4)}，${stats.unknownCost} 次费用待确认` : `估算费用 $${Number(stats.cost).toFixed(4)}`}</p>
    {stats.unknown > 0 && <p>有 {stats.unknown} 次请求正在处理或结果未确认。系统会避免重复付费；长期未确认时请核对服务商调用记录。</p>}
  </section>;
}
