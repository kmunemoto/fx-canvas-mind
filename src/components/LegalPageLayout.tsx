import LandingHeader from "./LandingHeader";
import LandingFooter from "./LandingFooter";

interface LegalPageLayoutProps {
  title: string;
  children: React.ReactNode;
}

const LegalPageLayout = ({ title, children }: LegalPageLayoutProps) => (
  <div className="min-h-screen bg-[#0a0e17] text-foreground">
    <LandingHeader />
    <main className="container max-w-3xl mx-auto px-4 py-16 md:py-24">
      <h1 className="text-3xl md:text-4xl font-bold mb-10">{title}</h1>
      <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground leading-relaxed [&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-10 [&_h2]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_p]:mb-3">
        {children}
      </div>
    </main>
    <LandingFooter />
  </div>
);

export default LegalPageLayout;
