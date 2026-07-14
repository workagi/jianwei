import Link from "next/link";

export const dynamic = "force-dynamic";

export default function StarredPage() {
  return (
    <main className="reader-page">
      <section className="reader-hero">
        <div>
          <div className="eyebrow">收藏</div>
          <h1>我的收藏</h1>
          <p>收藏功能即将上线——届时点击信息流卡片上的书签即可把文章暂存到这里。</p>
        </div>
      </section>
      <div className="empty-state">
        <p>
          先去 <Link href="/?platform=wechat" className="inline-link">微信公众号</Link> 看看最新文章吧。
        </p>
      </div>
    </main>
  );
}
