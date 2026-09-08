import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowUpRight, AudioLines, Bot, Headphones, MessageCircle, Mic, Radio, Sparkles, Workflow } from "lucide-react";
import styles from "./welcome.module.css";

export const metadata = {
  title: "Welcome · Telnyx Genesys Integrations",
  description: "Connect Genesys Cloud with Telnyx Audio Connector, Chat Widget, Voice Widget and natural text-to-speech voices.",
};

const features = [
  { number: "02", icon: MessageCircle, title: "Chat Widget", label: "AI chat on your website", description: "Embed a branded chat widget on your website. Let visitors talk to a Telnyx AI assistant and continue with a Genesys agent through Open Messaging when they need a person.", className: "widgets" },
  { number: "03", icon: Mic, title: "Voice Widget", label: "Voice AI in the browser", description: "Let visitors speak to a Telnyx AI assistant directly from your website. Offer a branded browser calling experience with a transcript and a handoff to your Genesys team.", className: "voice" },
  { number: "04", icon: AudioLines, title: "A voice that feels natural.", label: "Text to speech", description: "Bring Telnyx voices into Genesys Architect. Choose your voice and language, then listen before you publish.", className: "speech" },
  { number: "05", icon: Headphones, title: "A handoff with the whole story.", label: "Agent experience", description: "Connect customers to the right Genesys queue, with conversation summaries and context ready for the agent.", className: "handoff" },
  { number: "06", icon: Radio, title: "Stay close to every event.", label: "Live notifications", description: "Explore Genesys event topics, subscribe to the ones that matter and inspect incoming events in real time.", className: "events" },
  { number: "07", icon: Workflow, title: "One place to bring it together.", label: "Integration management", description: "Configure components, manage assistants and tools, and review the resources connected to your installation.", className: "management" },
];

export default function HomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link href="/" className={styles.brand} aria-label="Telnyx Genesys integrations home"><Image src="/telnyx.svg" alt="Telnyx" width={200} height={52} className={styles.brandLogo} priority /><span className={styles.brandDivider} /> <Image src="/genesys-logo.svg" alt="Genesys" width={655} height={121} className={styles.brandPartner} priority /></Link>
          <span className={styles.headerNote}>Better conversations, connected.</span>
        </header>

        <section className={styles.hero} aria-labelledby="welcome-title">
          <div className={styles.eyebrow}><span /> WELCOME TO YOUR INTEGRATION SUITE</div>
          <h1 id="welcome-title">Every conversation.<br /><span>More possibility.</span></h1>
          <div className={styles.heroBottom}>
            <p>Connect Genesys Cloud with Telnyx AI, chat and voice.<br className={styles.desktopBreak} /> Build experiences that flow naturally from the first hello to the human handoff.</p>
            <a href="#capabilities" className={styles.explore}>Explore the suite <ArrowDown size={18} aria-hidden="true" /></a>
          </div>
          <div className={styles.heroLine} aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
        </section>

        <section id="capabilities" className={styles.capabilities} aria-labelledby="capabilities-title">
          <div className={styles.sectionHeading}><h2 id="capabilities-title">One suite. Connected experiences.</h2><span>DISCOVER WHAT’S INSIDE</span></div>
          <div className={styles.grid}>
            <article className={`${styles.tile} ${styles.ai}`}>
              <div className={styles.tileTop}><span className={styles.icon}><Bot size={23} strokeWidth={1.6} aria-hidden="true" /></span><span className={styles.number}>01</span></div>
              <p className={styles.label}>Native Genesys integration</p>
              <h3>Genesys Audio Connector</h3>
              <p className={styles.description}>Bring Telnyx conversational AI into your Genesys call flows. Connect through the native Audio Connector in Architect, then transfer the conversation to a Genesys agent with its context.</p>
              <div className={styles.conversation} aria-hidden="true"><span><Sparkles size={15} /> AI assistant</span><i /><span><Headphones size={15} /> Human agent</span></div>
              <div className={styles.tileFooter}>BUILT FOR VOICE. CONNECTED TO YOUR TEAM.<span aria-hidden="true">↗</span></div>
            </article>
            {features.map(({ number, icon: Icon, title, label, description, className }) => (
              <article key={number} className={`${styles.tile} ${styles[className]}`}>
                <div className={styles.tileTop}><span className={styles.icon}><Icon size={23} strokeWidth={1.6} aria-hidden="true" /></span><span className={styles.number}>{number}</span></div>
                <p className={styles.label}>{label}</p>
                <h3>{title}</h3>
                <p className={styles.description}>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <aside className={styles.getStarted}>
          <div><span className={styles.eyebrow}>YOUR NEXT STEP</span><h2>Make it your own.</h2><p>Open the Telnyx administration app in Genesys Cloud to configure your integrations and start building.</p></div>
          <div className={styles.startIcon} aria-hidden="true"><ArrowUpRight size={38} strokeWidth={1.3} /></div>
        </aside>
        <footer className={styles.footer}><span>Telnyx × Genesys Cloud</span><span>AI. Voice. Human connection.</span></footer>
      </div>
    </main>
  );
}
