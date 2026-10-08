import Link from 'next/link';
import { ArrowUpRight, Network, Archive, FileOutput, Terminal } from 'lucide-react';
const paths = [
  { icon: Network, title: 'Read the network', text: 'Scan public friendships. Explore communities, hubs and the observations behind every score.', href: '/docs/guides/network' },
  { icon: Archive, title: 'Keep time in view', text: 'Inspect dated SteamHistory captures, friendship periods and comment coverage.', href: '/docs/guides/history' },
  { icon: FileOutput, title: 'Take your data with you', text: 'Rebuild reports offline. Export JSON and CSV, then continue exploring in Gephi.', href: '/docs/guides/gephi' },
  { icon: Terminal, title: 'Work from the terminal', text: 'Scan, resume, estimate and import history through the same local engine.', href: '/docs/reference/cli' },
];
export default function Home() {
  return <main className="landing">
    <header className="landing-nav"><Link href="/" className="wordmark"><img src="/vapora.svg" width="32" height="32" alt="" />vapora</Link><nav aria-label="Main navigation"><Link href="/docs">Documentation</Link><a href="https://github.com/Microck/vapora">GitHub <ArrowUpRight size={14} /></a></nav></header>
    <section className="hero"><div className="hero-copy"><p className="eyebrow"><span /> PUBLIC STEAM NETWORKS / V2.2</p><h1>A network.<br />An observation.<br /><em>Never the whole story.</em></h1><p className="hero-description">Explore public Steam friend networks, inspect dated history, and export the evidence. Desktop, browser, or terminal. Your runs stay local.</p><div className="hero-actions"><Link className="button primary" href="/docs/getting-started/first-scan">Make your first scan <ArrowUpRight size={17} /></Link><a className="button" href="https://github.com/Microck/vapora/releases/latest">Download Vapora</a></div><p className="platforms">Windows x64 · Linux x64 · macOS Apple Silicon</p></div><figure className="hero-preview"><div className="preview-bar"><span>vapora / network explorer</span><span>PUBLIC OBSERVATIONS</span></div><img src="/screenshots/network.png" alt="Vapora network explorer showing a fixture network and selected profile" width="1366" height="768" /><figcaption>Local fixture profiles. Scores describe captured evidence.</figcaption></figure></section>
    <section className="entry-section" aria-labelledby="explore"><div className="section-label"><span>THE FIELD GUIDE</span><h2 id="explore">From first scan to full context.</h2><Link href="/docs">All documentation <ArrowUpRight size={15} /></Link></div><div className="entry-grid">{paths.map(({ icon: Icon, ...p }) => <Link className="entry-card" key={p.href} href={p.href}><Icon size={23} /><h3>{p.title}</h3><p>{p.text}</p><ArrowUpRight className="card-arrow" size={17} /></Link>)}</div></section>
    <section className="principles"><p>Public data has boundaries.</p><span>Private lists remain unknown. Missing observations remain visible. Rankings and location signals are heuristics.</span><Link href="/docs/explanation/privacy">Understand the limits <ArrowUpRight size={15} /></Link></section>
    <footer className="landing-footer"><span>vapora / independent, unofficial / MIT</span><span><Link href="/docs/project/development">Contribute</Link><a href="https://github.com/Microck/vapora/releases">Release notes</a></span></footer>
  </main>;
}
