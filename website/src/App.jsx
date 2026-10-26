import {
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  Captions,
  Check,
  Hand,
  Play,
  ScreenShare,
  Smartphone,
  Volume2
} from 'lucide-react';
import { motion } from 'motion/react';
import { FaApple, FaGooglePlay, FaLinux, FaWindows } from 'react-icons/fa';
import Navbar from '@/components/Navbar';
import HlsBackgroundVideo from '@/components/HlsBackgroundVideo';
import ShinyText from '@/components/ShinyText';
import { Button } from '@/components/ui/button';

const HERO_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260328_105406_16f4600d-7a92-4292-b96e-b19156c7830a.mp4';
const MODES_VIDEO = 'https://stream.mux.com/9JXDljEVWYwWu01PUkAemafDugK89o01BR6zqJ3aS9u00A.m3u8';
const REPO_URL = 'https://github.com/suhaanthayyil/relay-app';
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const RELEASE_VERSION = '1.2.0';

// Flip `live` to true (and fill in the App Store URL) once each store listing is approved.
const MOBILE_STORES = [
  {
    store: 'App Store',
    caption: 'Download on the',
    icon: FaApple,
    url: 'https://apps.apple.com/app/id6821441069',
    live: false
  },
  {
    store: 'Google Play',
    caption: 'Get it on',
    icon: FaGooglePlay,
    url: 'https://play.google.com/store/apps/details?id=com.suhaan.relay',
    live: false
  }
];

const MOBILE_FEATURES = [
  {
    title: 'Standalone on your phone',
    items: [
      'Blind Mode: hold to ask, or one-tap Quick Ask for money, colors, and dates',
      'Read Aloud: point at signs, menus, and documents',
      'Live captions with translation, Name Alert, and Catch Me Up',
      'Face-to-face Conversation mode, translated both ways',
      'Find My Object: haptic hot/cold guidance to lost keys or a phone',
      'Feel the Conversation: speech turned into Braille vibration for DeafBlind users',
      'Braille keyboard and haptic Braille reader',
      'Quick Phrases board and Loud Sound Alerts'
    ]
  },
  {
    title: 'Paired with your computer',
    items: [
      'Scan a QR code to pair over your Wi-Fi',
      'Remote Mic: put your phone near the speaker, captions appear on the computer',
      'Caption Mirror: follow the computer captions on your phone',
      'Classroom Broadcast: every phone gets the captions in its own language',
      'Night Guard: smoke alarm at night strobes the phone flashlight and vibrates',
      'Sound alerts from the computer as phone vibrations'
    ]
  }
];

const EASE_OUT = [0.22, 1, 0.36, 1];

const revealVariants = {
  hidden: { opacity: 0, y: 28, filter: 'blur(10px)' },
  visible: (delay = 0) => ({
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      duration: 0.7,
      delay,
      ease: EASE_OUT
    }
  })
};

const cardVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.985, filter: 'blur(8px)' },
  visible: (index = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      duration: 0.55,
      delay: 0.06 * index,
      ease: EASE_OUT
    }
  })
};

const DOWNLOADS = [
  {
    platform: 'macOS',
    variant: 'Apple Silicon',
    file: 'Relay-mac-arm64.dmg',
    icon: FaApple
  },
  {
    platform: 'macOS',
    variant: 'Intel',
    file: 'Relay-mac-x64.dmg',
    icon: FaApple
  },
  {
    platform: 'Windows',
    variant: 'x64',
    file: 'Relay-windows-x64-setup.exe',
    icon: FaWindows
  },
  {
    platform: 'Linux',
    variant: 'AppImage x64',
    file: 'Relay-linux-x64.AppImage',
    icon: FaLinux
  },
  {
    platform: 'Linux',
    variant: '.deb x64',
    file: 'Relay-linux-x64.deb',
    icon: FaLinux
  }
];

function Reveal({ children, className, delay = 0, amount = 0.25 }) {
  return (
    <motion.div
      className={className}
      variants={revealVariants}
      custom={delay}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount }}
    >
      {children}
    </motion.div>
  );
}

function SectionFadeTopBottom({ top = 200, bottom = 200 }) {
  return (
    <>
      <div
        className="pointer-events-none absolute top-0 left-0 right-0 z-[1]"
        style={{ height: top, background: 'linear-gradient(to bottom, black, transparent)' }}
      />
      <div
        className="pointer-events-none absolute bottom-0 left-0 right-0 z-[1]"
        style={{ height: bottom, background: 'linear-gradient(to top, black, transparent)' }}
      />
    </>
  );
}

function Hero() {
  return (
    <section id="home" className="relative h-screen min-h-[760px] overflow-hidden bg-black">
      <video autoPlay loop muted playsInline className="absolute inset-0 h-full w-full object-cover">
        <source src={HERO_VIDEO} type="video/mp4" />
      </video>

      <div className="absolute inset-0 bg-black/60" />

      <div className="relative z-10 h-full">
        <div className="mx-auto flex h-full max-w-7xl flex-col px-6 sm:px-8 lg:px-10">
          <div className="pt-28 md:pt-32 lg:pt-36">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <motion.p
                initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.65, delay: 0.15, ease: EASE_OUT }}
                className="max-w-xl text-sm md:text-base text-white/80"
              >
                Relay is a real-time accessibility overlay and phone companion that helps people with hearing and
                vision disabilities understand speech, sound, and context.
              </motion.p>
              <motion.p
                initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.65, delay: 0.25, ease: EASE_OUT }}
                className="text-sm md:text-base text-white/80 lg:text-right"
              >
                Desktop for macOS, Windows, and Linux. Mobile for iPhone and Android.
              </motion.p>
            </div>
          </div>

          <div className="flex flex-1 items-center pb-16 md:pb-20">
            <div className="max-w-6xl">
              <motion.p
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.35, ease: EASE_OUT }}
                className="text-xs md:text-sm uppercase tracking-[0.18em] text-white/80"
              >
                Accessibility-first overlay software
              </motion.p>

              <motion.h1
                initial={{ opacity: 0, y: 24, filter: 'blur(10px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.8, delay: 0.45, ease: EASE_OUT }}
                className="mt-4 text-5xl md:text-7xl xl:text-9xl leading-[1.02] tracking-tighter text-white font-medium"
              >
                <span className="block">Access</span>
                <ShinyText
                  text="Everything."
                  className="block leading-[1.12] pt-[0.03em] pb-[0.14em] overflow-visible"
                  baseColor="#64CEFB"
                  shineColor="#ffffff"
                  duration={3}
                  spread={100}
                />
              </motion.h1>

              <motion.div
                initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.65, delay: 0.62, ease: EASE_OUT }}
                className="mt-8 md:mt-10 flex flex-wrap items-center gap-4 md:gap-5"
              >
                <a
                  href="#download"
                  className="group inline-flex items-center gap-2 rounded-full border border-white/20 bg-black px-6 md:px-8 py-3 md:py-4 text-sm font-medium text-white transition-all duration-300 hover:bg-zinc-900 hover:-translate-y-0.5"
                >
                  Download Relay
                  <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                </a>

                <a
                  href="#features"
                  className="inline-flex items-center gap-2 text-sm text-white/80 hover:text-white transition-colors duration-300"
                >
                  <Play className="h-4 w-4 fill-current" /> Explore Features
                </a>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Features() {
  const cards = [
    {
      icon: Captions,
      title: 'Live Captions',
      text: 'Stream low-latency captions with speaker-aware labels in an always-on-top overlay.'
    },
    {
      icon: Bell,
      title: 'Priority Sound Alerts',
      text: 'Detect alarms, knocks, and other critical sounds and raise visible urgent alerts.'
    },
    {
      icon: ScreenShare,
      title: 'Context Assist',
      text: 'Answer spoken help requests by combining a screen snapshot with camera context.'
    },
    {
      icon: Hand,
      title: 'Gesture Controls',
      text: 'Use hand gestures in Deaf Mode for quick controls with confidence-gated recognition.'
    },
    {
      icon: Volume2,
      title: 'Voice Routing',
      text: 'Wake phrase command routing with immediate stop support for safe interruptions.'
    },
    {
      icon: Smartphone,
      title: 'Phone Companion',
      text: 'Pair your phone by QR code to use it as a remote mic, a caption screen, and a vibrating sound alert.'
    }
  ];

  return (
    <section id="features" className="max-w-7xl mx-auto px-8 lg:px-16 py-24 scroll-mt-32">
      <Reveal className="text-center" delay={0.04}>
        <div className="section-badge">Features</div>
        <h2 className="mt-6 section-heading">Real tools for real accessibility.</h2>
      </Reveal>

      <div className="mt-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {cards.map(({ icon: Icon, title, text }, index) => (
          <motion.article
            key={title}
            className="liquid-glass rounded-2xl p-6"
            variants={cardVariants}
            custom={index}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.22 }}
          >
            <div className="liquid-glass-strong rounded-full w-10 h-10 flex items-center justify-center transition-transform duration-300 group-hover:scale-105">
              <Icon className="h-5 w-5 text-white" />
            </div>
            <h3 className="mt-5 text-xl font-heading text-white font-semibold tracking-tight">{title}</h3>
            <p className="mt-3 text-white/70 font-body font-light text-sm">{text}</p>
          </motion.article>
        ))}
      </div>
    </section>
  );
}

function Modes() {
  return (
    <section id="modes" className="relative overflow-hidden py-24 scroll-mt-32">
      <HlsBackgroundVideo src={MODES_VIDEO} className="absolute inset-0 w-full h-full object-cover" />
      <SectionFadeTopBottom top={200} bottom={200} />

      <div className="relative z-10 max-w-7xl mx-auto px-8 lg:px-16">
        <Reveal className="text-center" delay={0.04}>
          <div className="section-badge">Modes</div>
          <h2 className="mt-6 section-heading">Switch instantly for user needs.</h2>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <motion.article
            className="liquid-glass rounded-2xl p-8"
            variants={cardVariants}
            custom={0}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.25 }}
          >
            <h3 className="text-2xl font-semibold text-white tracking-tight">Deaf Mode</h3>
            <p className="mt-3 text-white/70 text-sm md:text-base">
              Focus on visual understanding with live captions, speaker labels, and visual sound alerts.
            </p>
            <ul className="mt-6 space-y-2 text-white/80 text-sm">
              <li>- Always-on-top caption overlay</li>
              <li>- Speaker-aware transcript rendering</li>
              <li>- Gesture panel controls</li>
            </ul>
          </motion.article>

          <motion.article
            className="liquid-glass rounded-2xl p-8"
            variants={cardVariants}
            custom={1}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.25 }}
          >
            <h3 className="text-2xl font-semibold text-white tracking-tight">Blind Mode</h3>
            <p className="mt-3 text-white/70 text-sm md:text-base">
              Focus on spoken guidance with fast commands, context assistance, and interrupt-safe controls.
            </p>
            <ul className="mt-6 space-y-2 text-white/80 text-sm">
              <li>- Wake phrase command routing</li>
              <li>- Immediate global stop command</li>
              <li>- Context help from screen plus camera</li>
            </ul>
          </motion.article>
        </div>
      </div>
    </section>
  );
}

function StoreBadge({ store, caption, icon: Icon, url, live }) {
  const body = (
    <>
      <Icon className="h-7 w-7 shrink-0" aria-hidden="true" />
      <span className="flex flex-col text-left leading-tight">
        <span className="text-[11px] uppercase tracking-wide opacity-70">{live ? caption : 'Coming soon to'}</span>
        <span className="text-lg font-semibold">{store}</span>
      </span>
    </>
  );
  const base = 'inline-flex min-w-[200px] items-center gap-3 rounded-2xl border px-5 py-3 transition-all duration-300';
  if (live && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={`${base} border-white/20 bg-white text-black hover:-translate-y-0.5`}
      >
        {body}
      </a>
    );
  }
  return (
    <span className={`${base} border-white/15 bg-black/60 text-white/70`} aria-label={`${store}, coming soon`}>
      {body}
    </span>
  );
}

function Mobile() {
  return (
    <section id="mobile" className="max-w-7xl mx-auto px-8 lg:px-16 py-24 scroll-mt-32">
      <Reveal className="text-center" delay={0.04}>
        <div className="section-badge">Mobile</div>
        <h2 className="mt-6 section-heading">Relay in your pocket.</h2>
        <p className="mt-5 text-white/70 font-body font-light text-sm md:text-base max-w-2xl mx-auto">
          The Relay mobile app works on its own, and pairs with the desktop app to bring captions and alerts wherever you are.
        </p>
      </Reveal>

      <div className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {MOBILE_FEATURES.map(({ title, items }, index) => (
          <motion.article
            key={title}
            className="liquid-glass rounded-2xl p-8"
            variants={cardVariants}
            custom={index}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.25 }}
          >
            <h3 className="text-2xl font-semibold text-white tracking-tight">{title}</h3>
            <ul className="mt-6 space-y-2 text-white/80 text-sm">
              {items.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </motion.article>
        ))}
      </div>

      <Reveal className="mt-10 flex flex-wrap items-center justify-center gap-4" delay={0.1}>
        {MOBILE_STORES.map((badge) => (
          <StoreBadge key={badge.store} {...badge} />
        ))}
      </Reveal>
    </section>
  );
}

function Download() {
  return (
    <section id="download" className="py-24 scroll-mt-32">
      <div className="max-w-7xl mx-auto px-8 lg:px-16">
        <Reveal className="rounded-3xl border border-white/10 bg-black/40 p-10 md:p-14 text-center backdrop-blur-sm" delay={0.02}>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-heading text-white font-semibold tracking-tight leading-[0.9]">
            Ready to run Relay?
          </h2>
          <p className="mt-5 text-white/70 font-body font-light text-sm md:text-base max-w-2xl mx-auto">
            Download directly from the latest GitHub release. Choose the file for your operating system below.
          </p>

          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 text-left">
            {DOWNLOADS.map(({ platform, variant, file, icon: Icon }, index) => (
              <motion.article
                key={file}
                className="relative rounded-3xl border border-white/15 bg-black/70 p-6 md:p-7"
                variants={cardVariants}
                custom={index}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, amount: 0.2 }}
              >
                <Check className="absolute right-6 top-6 h-6 w-6 text-white/80" />

                <div className="mx-auto mt-2 flex h-24 w-24 items-center justify-center rounded-3xl bg-white text-black">
                  <Icon className="h-11 w-11" />
                </div>

                <h3 className="mt-7 text-center text-4xl font-semibold tracking-tight text-white">{platform}</h3>
                <p className="mt-2 text-center text-sm text-white/45">{variant}</p>
                <p className="mt-1 text-center text-3xl text-white/35">{RELEASE_VERSION}</p>

                <a
                  href={`${RELEASES_URL}/download/${file}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-8 inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-zinc-800 px-5 py-4 text-3xl font-medium text-white/85 transition-all duration-300 hover:bg-zinc-700 hover:text-white hover:-translate-y-0.5"
                >
                  <ArrowDownToLine className="h-8 w-8" />
                  Download
                </a>
              </motion.article>
            ))}
          </div>

          <Reveal className="mt-8 flex flex-wrap items-center justify-center gap-4" delay={0.15}>
            <Button className="rounded-full px-6 py-3 h-auto" asChild>
              <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                View All Release Files <ArrowUpRight className="h-4 w-4" />
              </a>
            </Button>
            <Button variant="solid" className="rounded-full px-6 py-3 h-auto" asChild>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                Open Repository
              </a>
            </Button>
          </Reveal>
        </Reveal>

        <Reveal
          className="mt-16 pt-8 border-t border-white/10 flex flex-col md:flex-row gap-4 md:gap-0 justify-between items-center"
          delay={0.06}
        >
          <p className="text-white/40 text-xs font-body">(c) 2026 Relay. Built by Suhaan Thayyil and Arnav Kanderi.</p>
          <div className="flex flex-wrap items-center justify-center gap-6 text-white/40 text-xs font-body">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="/support">Support</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default function App() {
  return (
    <div className="bg-black min-h-screen">
      <div className="relative z-10">
        <Navbar />
        <Hero />
        <div className="bg-black">
          <Features />
          <Modes />
          <Mobile />
          <Download />
        </div>
      </div>
    </div>
  );
}
