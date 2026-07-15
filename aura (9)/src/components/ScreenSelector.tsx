import React, { useState } from 'react';
import { Screen } from '../types';

interface ScreenSelectorProps {
  currentScreen: Screen;
  onSelectScreen: (screen: Screen) => void;
  userRegistered: boolean;
}

export const ScreenSelector: React.FC<ScreenSelectorProps> = ({
  currentScreen,
  onSelectScreen,
  userRegistered,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const screensList: { id: Screen; label: string; group: string }[] = [
    { id: 'welcome', label: 'Welcome Splash', group: 'Onboarding' },
    { id: 'signin', label: 'Sign In Page', group: 'Onboarding' },
    { id: 'onboarding_basics', label: 'Step 1: Basics', group: 'Onboarding' },
    { id: 'onboarding_interests', label: 'Step 2: Sparks', group: 'Onboarding' },
    { id: 'onboarding_photos', label: 'Step 3: Best Self', group: 'Onboarding' },
    { id: 'location_access', label: 'Location Access', group: 'Onboarding' },
    { id: 'discover', label: 'Discover Feed', group: 'Main Feed' },
    { id: 'profile_details', label: 'Profile Details', group: 'Main Feed' },
    { id: 'spark_match', label: 'Spark Match Popup', group: 'Main Feed' },
    { id: 'chat', label: 'Chat Screen', group: 'Social' },
    { id: 'stories', label: 'Stories & Activity', group: 'Social' },
    { id: 'notifications', label: 'Notifications & Follow Backs', group: 'Social' },
    { id: 'edit_profile', label: 'Edit Profile', group: 'Account' },
    { id: 'creator_monetization', label: 'Ad Revenue', group: 'Account' },
    { id: 'aura_gold', label: 'Aura Gold Plan', group: 'Account' },
  ];

  const grouped = screensList.reduce((acc, curr) => {
    if (!acc[curr.group]) acc[curr.group] = [];
    acc[curr.group].push(curr);
    return acc;
  }, {} as Record<string, typeof screensList>);

  return (
    <div className="fixed top-1/2 left-4 z-[9999] -translate-y-1/2 hidden md:block">
      {!isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white shadow-xl hover:scale-110 active:scale-95"
          title="Open Screen Switcher"
          id="open-screen-switcher-btn"
        >
          <span className="material-symbols-outlined text-[24px]">dashboard</span>
        </button>
      ) : (
        <div className="flex max-h-[85vh] w-64 flex-col rounded-3xl bg-[#ffffff] p-5 shadow-2xl border border-primary-fixed/20 scrollbar-hide overflow-y-auto">
          <div className="mb-4 flex items-center justify-between border-b border-primary-fixed/20 pb-2">
            <div>
              <h3 className="font-title-md text-[16px] text-primary">Interactive Preview</h3>
              <p className="text-[10px] text-secondary">Switch between screens instantly</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-secondary hover:text-primary active:scale-90"
              id="close-screen-switcher-btn"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          <div className="space-y-4">
            {Object.entries(grouped).map(([groupName, items]) => (
              <div key={groupName} className="space-y-1.5">
                <span className="text-[10px] font-semibold tracking-wider text-primary-fixed-variant uppercase">
                  {groupName}
                </span>
                <div className="space-y-1">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => onSelectScreen(item.id)}
                      className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all flex items-center justify-between ${
                        currentScreen === item.id
                          ? 'bg-primary text-white font-medium shadow-md'
                          : 'bg-surface-container-lowest text-on-surface hover:bg-primary-fixed/25'
                      }`}
                      id={`switch-screen-${item.id}`}
                    >
                      <span>{item.label}</span>
                      {currentScreen === item.id && (
                        <span className="w-1.5 h-1.5 bg-white rounded-full"></span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 border-t border-primary-fixed/25 pt-3">
            <div className="rounded-xl bg-surface-container-low p-2.5 text-[10px] text-on-surface-variant space-y-1">
              <p className="font-semibold text-primary">⚡ Click-through demo:</p>
              <p>You can also navigate naturally inside the phone app viewport via buttons!</p>
              <p className="text-[9px] opacity-75">Registered state: <b className="text-primary">{userRegistered ? 'YES' : 'NO'}</b></p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
