import React, { useState } from 'react';

interface ProfileImageProps {
  src?: string | null;
  name?: string | null;
  className?: string;
  alt?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement | HTMLImageElement>) => void;
}

export const ProfileImage: React.FC<ProfileImageProps> = ({
  src,
  name,
  className = "w-full h-full object-cover",
  alt = "Profile photo",
  onClick,
}) => {
  const [hasError, setHasError] = useState(false);

  // Filter out any legacy/demo Google AI Studio placeholder URLs
  const isDemo = src && (src.includes('lh3.googleusercontent.com/aida-public/') || src.includes('googleusercontent.com/aida-public/'));
  const shouldShowFallback = hasError || !src || isDemo;

  const getInitial = (n: string | null | undefined) => {
    if (!n) return '?';
    const trimmed = n.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  };

  if (shouldShowFallback) {
    const initial = getInitial(name);
    return (
      <div
        onClick={onClick}
        className={`bg-slate-300 text-slate-700 flex items-center justify-center font-bold select-none shrink-0 ${className} ${onClick ? 'cursor-pointer' : ''}`}
        title={name || undefined}
      >
        <span>{initial}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onClick={onClick}
      onError={() => setHasError(true)}
    />
  );
};
