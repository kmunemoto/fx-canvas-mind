import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Calendar, ArrowRight } from "lucide-react";
import LandingHeader from "@/components/LandingHeader";
import LandingFooter from "@/components/LandingFooter";
import { blogPosts, BLOG_CATEGORIES, type BlogCategory } from "@/data/blogPosts";
import { useLocale } from "@/lib/i18n";

const Blog = () => {
  const { t, locale } = useLocale();
  const [activeCategory, setActiveCategory] = useState<"全て" | BlogCategory>("全て");

  const filtered = useMemo(() => {
    const posts = activeCategory === "全て"
      ? blogPosts
      : blogPosts.filter((p) => p.category === activeCategory);
    return [...posts].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  }, [activeCategory]);

  const baseUrl = "https://fx-tactical.jp";

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-foreground">
      <Helmet>
        <title>ブログ｜FX Tactical Analyzer</title>
        <meta name="description" content="FXテクニカル分析・ファンダメンタル分析・AI活用に関する解説記事を掲載。初心者から経験者まで役立つトレード知識を発信中。" />
        <link rel="canonical" href={`${baseUrl}/blog`} />
        <meta property="og:title" content="ブログ｜FX Tactical Analyzer" />
        <meta property="og:description" content="FXテクニカル分析・ファンダメンタル分析・AI活用に関する解説記事。" />
        <meta property="og:url" content={`${baseUrl}/blog`} />
        <meta property="og:type" content="website" />
      </Helmet>

      <LandingHeader />

      <main className="container max-w-6xl mx-auto px-4 py-12 md:py-20">
        <div className="mb-10 text-center">
          <h1 className="text-3xl md:text-4xl font-bold mb-3">{t.blog.title}</h1>
          <p className="text-muted-foreground text-sm md:text-base">
            {t.blog.subtitle}
          </p>
        </div>

        {locale !== "ja" && (
          <p className="text-center text-xs text-muted-foreground mb-8">{t.blog.japaneseOnly}</p>
        )}

        {/* Category filter */}
        <div className="flex flex-wrap justify-center gap-2 mb-10">
          {BLOG_CATEGORIES.map((cat) => {
            const active = activeCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all border ${
                  active
                    ? "bg-[#00d4ff] text-[#0a0a0f] border-[#00d4ff]"
                    : "border-white/10 text-muted-foreground hover:border-[#00d4ff]/50 hover:text-foreground"
                }`}
              >
                {/* Category names label Japanese articles, so only the
                    "all" pill is translated. */}
                {cat === "全て" ? t.blog.all : cat}
              </button>
            );
          })}
        </div>

        {/* Posts grid */}
        {filtered.length === 0 ? (
          <p className="text-center text-muted-foreground py-20">{t.blog.none}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((post) => (
              <Link
                key={post.slug}
                to={`/blog/${post.slug}`}
                className="group rounded-2xl overflow-hidden border border-white/10 bg-[#0f1320] hover:border-[#00d4ff]/60 hover:shadow-[0_0_25px_rgba(0,212,255,0.15)] transition-all"
              >
                <div className="aspect-video overflow-hidden bg-black">
                  <img
                    src={post.thumbnailUrl}
                    alt={post.title}
                    width={1280}
                    height={720}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </div>
                <div className="p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#00d4ff]/15 text-[#00d4ff]">
                      {post.category}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Calendar className="h-3 w-3" />
                      {post.publishedAt}
                    </span>
                  </div>
                  <h2 className="font-bold text-base leading-snug mb-2 group-hover:text-[#00d4ff] transition-colors line-clamp-2">
                    {post.title}
                  </h2>
                  <p className="text-xs text-muted-foreground line-clamp-3">{post.description}</p>
                  <div className="mt-4 flex items-center gap-1 text-xs text-[#00d4ff] font-semibold">
                    {t.blog.readMore} <ArrowRight className="h-3 w-3" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <LandingFooter />
    </div>
  );
};

export default Blog;
