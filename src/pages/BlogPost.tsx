import { useEffect, useMemo, useState } from "react";
import { Link, useParams, Navigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { toast } from "sonner";
import { Calendar, Clock, ArrowRight, Share2, Link as LinkIcon, MessageCircle, Check } from "lucide-react";
import { useT } from "@/lib/i18n";
import LandingHeader from "@/components/LandingHeader";
import LandingFooter from "@/components/LandingFooter";
import { getPostBySlug, getRelatedPosts, estimateReadingTime } from "@/data/blogPosts";

interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

function extractToc(html: string): TocItem[] {
  const items: TocItem[] = [];
  const regex = /<h([23])\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    items.push({
      level: Number(m[1]) as 2 | 3,
      id: m[2],
      text: m[3].replace(/<[^>]+>/g, "").trim(),
    });
  }
  return items;
}

const BlogPost = () => {
  const t = useT();
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getPostBySlug(slug) : undefined;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [slug]);

  const toc = useMemo(() => (post ? extractToc(post.content) : []), [post]);
  const related = useMemo(() => (post ? getRelatedPosts(post.slug) : []), [post]);
  const readingTime = useMemo(() => (post ? estimateReadingTime(post.content) : 0), [post]);

  if (!post) return <Navigate to="/blog" replace />;

  const baseUrl = "https://fx-tactical.jp";
  const url = `${baseUrl}/blog/${post.slug}`;
  const shareText = `${post.title} | FX Tactical Analyzer`;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t.blog.copiedToast);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t.blog.copyFailed);
    }
  };

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.description,
    image: [post.thumbnailUrl.startsWith("http") ? post.thumbnailUrl : `${baseUrl}${post.thumbnailUrl}`],
    datePublished: post.publishedAt,
    dateModified: post.publishedAt,
    author: { "@type": "Organization", name: "FX Tactical Analyzer" },
    publisher: {
      "@type": "Organization",
      name: "FX Tactical Analyzer",
      logo: { "@type": "ImageObject", url: `${baseUrl}/icons/icon-512x512.png` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-foreground">
      <Helmet>
        <title>{`${post.title}｜FX Tactical Analyzer`}</title>
        <meta name="description" content={post.description} />
        <link rel="canonical" href={url} />
        <meta property="og:title" content={post.title} />
        <meta property="og:description" content={post.description} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={url} />
        <meta property="og:image" content={post.thumbnailUrl.startsWith("http") ? post.thumbnailUrl : `${baseUrl}${post.thumbnailUrl}`} />
        <meta property="article:published_time" content={post.publishedAt} />
        <meta property="article:section" content={post.category} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={post.title} />
        <meta name="twitter:description" content={post.description} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      <LandingHeader />

      <main className="container max-w-4xl mx-auto px-4 py-10 md:py-16">
        {/* Breadcrumb */}
        <nav className="text-xs text-muted-foreground mb-6">
          <Link to="/" className="hover:text-foreground">{t.blog.home}</Link>
          <span className="mx-2">/</span>
          <Link to="/blog" className="hover:text-foreground">{t.blog.title}</Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">{post.category}</span>
        </nav>

        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#00d4ff]/15 text-[#00d4ff]">
              {post.category}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" /> {post.publishedAt}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" /> {t.blog.readingTime(readingTime)}
            </span>
          </div>
          <h1 className="text-2xl md:text-4xl font-bold leading-tight mb-4">{post.title}</h1>
          <p className="text-sm md:text-base text-muted-foreground">{post.description}</p>
        </header>

        <div className="rounded-2xl overflow-hidden border border-white/10 mb-8">
          <img
            src={post.thumbnailUrl}
            alt={post.title}
            width={1280}
            height={720}
            className="w-full h-auto"
          />
        </div>

        {/* Table of contents */}
        {toc.length > 0 && (
          <aside className="mb-10 p-5 rounded-xl border border-white/10 bg-[#0f1320]">
            <h2 className="text-sm font-bold text-[#00d4ff] mb-3">{t.blog.toc}</h2>
            <ol className="space-y-1.5 text-sm">
              {toc.map((item) => (
                <li key={item.id} className={item.level === 3 ? "ml-4" : ""}>
                  <a href={`#${item.id}`} className="text-muted-foreground hover:text-[#00d4ff] transition-colors">
                    {item.text}
                  </a>
                </li>
              ))}
            </ol>
          </aside>
        )}

        {/* Article content */}
        <article
          className="blog-content"
          dangerouslySetInnerHTML={{ __html: post.content }}
        />

        {/* Share */}
        <section className="mt-12 p-6 rounded-2xl border border-white/10 bg-[#0f1320]">
          <h2 className="flex items-center gap-2 text-sm font-bold mb-4">
            <Share2 className="h-4 w-4 text-[#00d4ff]" /> {t.blog.share}
          </h2>
          <div className="flex flex-wrap gap-3">
            <a
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`}
              target="_blank" rel="noopener noreferrer"
              className="px-4 py-2 rounded-lg bg-[#00d4ff]/10 border border-[#00d4ff]/30 text-[#00d4ff] text-sm font-semibold hover:bg-[#00d4ff]/20 transition-colors"
            >
              {t.blog.shareX}
            </a>
            <a
              href={`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`}
              target="_blank" rel="noopener noreferrer"
              className="px-4 py-2 rounded-lg bg-[#00d4ff]/10 border border-[#00d4ff]/30 text-[#00d4ff] text-sm font-semibold hover:bg-[#00d4ff]/20 transition-colors flex items-center gap-1.5"
            >
              <MessageCircle className="h-4 w-4" /> {t.blog.shareLine}
            </a>
            <button
              onClick={onCopy}
              className="px-4 py-2 rounded-lg bg-[#00d4ff]/10 border border-[#00d4ff]/30 text-[#00d4ff] text-sm font-semibold hover:bg-[#00d4ff]/20 transition-colors flex items-center gap-1.5"
            >
              {copied ? <Check className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
              {copied ? t.blog.copied : t.blog.copyLink}
            </button>
          </div>
        </section>

        {/* Related */}
        {related.length > 0 && (
          <section className="mt-12">
            <h2 className="text-xl font-bold mb-6">{t.blog.related}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {related.map((p) => (
                <Link
                  key={p.slug}
                  to={`/blog/${p.slug}`}
                  className="group rounded-xl overflow-hidden border border-white/10 bg-[#0f1320] hover:border-[#00d4ff]/60 transition-all"
                >
                  <div className="aspect-video overflow-hidden bg-black">
                    <img src={p.thumbnailUrl} alt={p.title} loading="lazy" width={1280} height={720} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                  </div>
                  <div className="p-4">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#00d4ff]/15 text-[#00d4ff]">
                      {p.category}
                    </span>
                    <h3 className="font-bold text-sm mt-2 group-hover:text-[#00d4ff] transition-colors line-clamp-2">
                      {p.title}
                    </h3>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Bottom CTA */}
        <section className="mt-12 p-8 rounded-2xl text-center border border-[#00d4ff]/30 bg-gradient-to-br from-[#00d4ff]/15 via-[#00d4ff]/5 to-transparent">
          <h2 className="text-xl md:text-2xl font-bold mb-3">{t.blog.ctaTitle}</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-xl mx-auto">
            {t.blog.ctaBody}
          </p>
          <Link
            to="/login?tab=signup"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[#00d4ff] text-[#0a0a0f] font-bold hover:opacity-90 transition-opacity"
          >
            {t.landing.startFree} <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
};

export default BlogPost;
