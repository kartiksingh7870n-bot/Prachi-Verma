import React, { useState, useEffect } from 'react';
import { X, Volume2, VolumeX, Sparkles, ExternalLink } from 'lucide-react';

export const DEMO_ADS_ENABLED = true;

// Predefined high-quality mock creative templates for Banner Ads
const AD_CREATIVES = [
  {
    title: "Nova Sleep Tracker",
    description: "Align your sleep cycles with your daily rhythm. Tap to download.",
    cta: "Install Now",
    badge: "Sponsored",
    gradient: "from-[#4f46e5] to-[#06b6d4]",
    accentColor: "text-indigo-400"
  },
  {
    title: "Vibe Coffee Roasters",
    description: "Find your daily focus. Get 50% off your first order with code 'AURA50'.",
    cta: "Claim Deal",
    badge: "Sponsored",
    gradient: "from-[#f59e0b] to-[#b45309]",
    accentColor: "text-amber-500"
  },
  {
    title: "Apex Fitness Studio",
    description: "Track your heart, unlock your power. Free 14-day trial pass.",
    cta: "Learn More",
    badge: "Ad",
    gradient: "from-[#ec4899] to-[#f43f5e]",
    accentColor: "text-pink-500"
  }
];

interface BannerAdProps {
  creativeIndex?: number;
  onClose?: () => void;
  className?: string;
}

export const BannerAd: React.FC<BannerAdProps> = ({ creativeIndex = 0, onClose, className = "" }) => {
  const [visible, setVisible] = useState(true);
  const creative = AD_CREATIVES[creativeIndex % AD_CREATIVES.length];

  if (!visible) return null;

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setVisible(false);
    if (onClose) onClose();
  };

  return (
    <div className={`relative w-full max-w-xl mx-auto overflow-hidden rounded-2xl bg-white border border-[#e2e8f0] shadow-sm hover:shadow-md transition-all duration-300 p-4 flex gap-4 ${className}`}>
      {/* Ad Badge */}
      <div className="absolute top-2 right-10 px-1.5 py-0.5 bg-slate-100 text-[9px] font-semibold text-slate-500 rounded tracking-wider uppercase border border-slate-200">
        {creative.badge}
      </div>

      {/* Close button */}
      <button 
        onClick={handleClose}
        className="absolute top-2 right-2 p-1 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors cursor-pointer"
        aria-label="Close Ad"
      >
        <X size={14} />
      </button>

      {/* Creative Placeholder Image (Styled CSS Gradient Box) */}
      <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-xl bg-gradient-to-tr ${creative.gradient} shrink-0 flex items-center justify-center text-white relative shadow-inner overflow-hidden`}>
        <div className="absolute inset-0 bg-black/10 mix-blend-overlay"></div>
        <Sparkles size={24} className="animate-pulse" />
      </div>

      {/* Text Info */}
      <div className="flex flex-col justify-between flex-1 pr-6">
        <div>
          <h4 className="text-sm font-bold text-slate-800 leading-tight flex items-center gap-1.5">
            {creative.title}
            <ExternalLink size={12} className="text-slate-400 shrink-0" />
          </h4>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed line-clamp-2">
            {creative.description}
          </p>
        </div>
        
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold text-indigo-600 uppercase tracking-wider">
            Sponsored Link
          </span>
          <button 
            onClick={() => window.open('https://example.com/demo-ad', '_blank', 'noopener,noreferrer')}
            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-1"
          >
            <span>{creative.cta}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

interface VideoAdProps {
  onComplete: () => void;
  onClose: () => void;
}

export const VideoAd: React.FC<VideoAdProps> = ({ onComplete, onClose }) => {
  const [timeLeft, setTimeLeft] = useState(5);
  const [isMuted, setIsMuted] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);

  useEffect(() => {
    // Lock background scroll when video ad overlay is open
    document.body.style.overflow = 'hidden';
    
    const countdownInterval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(countdownInterval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    const progressInterval = setInterval(() => {
      setVideoProgress((prev) => {
        if (prev >= 100) {
          clearInterval(progressInterval);
          return 100;
        }
        return prev + 2; // Increments to 100% over ~5 seconds (50 steps of 100ms)
      });
    }, 100);

    return () => {
      document.body.style.overflow = 'unset';
      clearInterval(countdownInterval);
      clearInterval(progressInterval);
    };
  }, []);

  const handleClaimReward = () => {
    onComplete();
  };

  const handleSkip = () => {
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-4 backdrop-blur-md">
      {/* Main Video Ad Shell */}
      <div className="relative w-full max-w-lg aspect-video rounded-2xl bg-gradient-to-tr from-slate-900 via-indigo-950 to-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col justify-between">
        
        {/* Top Control Bar */}
        <div className="p-3 flex justify-between items-center z-10 bg-gradient-to-b from-black/60 to-transparent">
          {/* Ad Badge */}
          <div className="px-2 py-0.5 bg-black/60 text-[10px] font-bold text-white rounded tracking-wider uppercase border border-white/20">
            Ad · Rewarded Video
          </div>

          {/* Sound toggle and skip/countdown indicator */}
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className="p-1.5 bg-black/40 hover:bg-black/60 text-white rounded-full transition-colors cursor-pointer"
            >
              {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            
            {timeLeft > 0 ? (
              <span className="text-xs font-semibold text-white/90 bg-black/40 px-3 py-1.5 rounded-full tracking-wide">
                Skip Ad in {timeLeft}s
              </span>
            ) : (
              <button 
                onClick={handleSkip}
                className="text-xs font-bold text-white bg-slate-700/80 hover:bg-slate-700 hover:text-white px-3 py-1.5 rounded-full flex items-center gap-1 transition-all cursor-pointer"
              >
                <X size={14} />
                <span>Skip</span>
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Video Simulation Content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center select-none pointer-events-none">
          {/* Pulsing visual circles replicating dynamic media playback */}
          <div className="relative w-24 h-24 flex items-center justify-center mb-4">
            <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping"></div>
            <div className="absolute inset-2 rounded-full bg-indigo-500/20 animate-pulse"></div>
            <div className="w-16 h-16 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <Sparkles size={28} className="text-white animate-spin" style={{ animationDuration: '6s' }} />
            </div>
          </div>
          
          <h3 className="text-xl font-extrabold text-white tracking-tight drop-shadow-md">
            Unleash Your Aura Premium
          </h3>
          <p className="text-xs text-slate-300 mt-2 max-w-xs leading-relaxed drop-shadow">
            Discover matching sparks around the globe. Instant matches, zero limits, direct chats, and daily highlights!
          </p>
        </div>

        {/* Bottom Control Bar with Playback Progress */}
        <div className="z-10 bg-gradient-to-t from-black/80 to-transparent p-4 flex flex-col gap-3">
          {/* Seek/Progress bar */}
          <div className="w-full bg-white/20 h-1.5 rounded-full overflow-hidden">
            <div 
              className="bg-indigo-500 h-full transition-all duration-100 ease-out rounded-full" 
              style={{ width: `${videoProgress}%` }}
            ></div>
          </div>

          {/* Reward Status / Action */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
              <Sparkles size={14} className="animate-bounce" />
              <span>Watch to the end to claim +5 Sparks!</span>
            </div>
            
            {timeLeft === 0 && (
              <button 
                onClick={handleClaimReward}
                className="px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-600 hover:to-yellow-500 text-slate-900 text-xs font-black rounded-xl shadow-lg hover:shadow-amber-500/20 active:scale-95 transition-all cursor-pointer flex items-center gap-1"
              >
                <Sparkles size={14} />
                <span>CLAIM REWARD</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
