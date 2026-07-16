import React, { useState, useEffect, useRef } from 'react';
import { Screen, UserProfile, Message, Story, AppNotification } from './types';
import {
  IMAGES,
  INITIAL_USER,
  INITIAL_CHAT,
  INTERESTS_OPTIONS,
} from './data';
import { DEMO_ADS_ENABLED, BannerAd, VideoAd } from './components/DemoAds';
import { ProfileImage } from './components/ProfileImage';
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  signInWithCredential
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './lib/firebase';
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';

const getMessageDateLabel = (dateStr?: string) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) {
    return 'Today';
  } else if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  } else {
    return d.toLocaleDateString([], { month: 'long', day: 'numeric' });
  }
};

const compressImage = (base64Str: string, maxWidth = 450, maxHeight = 450, quality = 0.7): Promise<string> => {
  return new Promise((resolve) => {
    if (!base64Str || !base64Str.startsWith('data:image/')) {
      resolve(base64Str);
      return;
    }
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } else {
        resolve(base64Str);
      }
    };
    img.onerror = () => {
      resolve(base64Str);
    };
  });
};

const compressVideo = (base64Str: string, maxWidth = 360, maxHeight = 640): Promise<string> => {
  return new Promise((resolve) => {
    if (!base64Str || !base64Str.startsWith('data:video/')) {
      resolve(base64Str);
      return;
    }
    if (!window.MediaRecorder) {
      console.warn('MediaRecorder not supported, skipping video compression');
      resolve(base64Str);
      return;
    }

    const video = document.createElement('video');
    video.src = base64Str;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    video.onloadedmetadata = () => {
      let width = video.videoWidth;
      let height = video.videoHeight;
      const aspectRatio = width / height;

      if (width > height) {
        if (width > maxWidth) {
          width = maxWidth;
          height = Math.round(width / aspectRatio);
        }
      } else {
        if (height > maxHeight) {
          height = maxHeight;
          width = Math.round(height * aspectRatio);
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Str);
        return;
      }

      let stream: MediaStream | null = null;
      try {
        stream = (canvas as any).captureStream ? (canvas as any).captureStream(15) : null;
        if (!stream) {
          resolve(base64Str);
          return;
        }
      } catch (e) {
        resolve(base64Str);
        return;
      }

      const options = {
        mimeType: 'video/webm;codecs=vp8',
        videoBitsPerSecond: 200000
      };
      
      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = new MediaRecorder(stream, options);
      } catch (e) {
        try {
          mediaRecorder = new MediaRecorder(stream);
        } catch (err) {
          resolve(base64Str);
          return;
        }
      }

      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) {
          chunks.push(evt.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result as string);
        };
        reader.readAsDataURL(blob);
      };

      video.play();
      mediaRecorder.start();

      const drawFrame = () => {
        if (video.paused || video.ended) {
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
          }
          return;
        }
        ctx.drawImage(video, 0, 0, width, height);
        requestAnimationFrame(drawFrame);
      };

      video.onplay = () => {
        requestAnimationFrame(drawFrame);
        setTimeout(() => {
          if (mediaRecorder.state === 'recording') {
            video.pause();
            mediaRecorder.stop();
          }
        }, 5000); // Max 5 seconds
      };

      video.onerror = () => {
        resolve(base64Str);
      };
    };

    video.onerror = () => {
      resolve(base64Str);
    };
  });
};

export interface ChatPartner {
  id: string;
  name: string;
  photo: string;
  bio?: string;
  age?: number;
  username?: string;
  isDemo?: boolean;
}

const AVAILABLE_PEOPLE: ChatPartner[] = [];

export default function App() {
  // App States
  const [windowWidth, setWindowWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1024);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [userRegistered, setUserRegistered] = useState(() => {
    return localStorage.getItem('aura_user_registered') === 'true';
  });
  const [isGuest, setIsGuest] = useState(() => {
    return localStorage.getItem('aura_is_guest') === 'true';
  });
  const [currentScreen, setCurrentScreen] = useState<Screen>(() => {
    const saved = localStorage.getItem('aura_current_screen') as Screen;
    return (saved && saved !== 'welcome' && saved !== 'signin' && saved !== 'onboarding_basics' && saved !== 'onboarding_interests' && saved !== 'onboarding_photos') ? saved : 'welcome';
  });
  const [previousScreen, setPreviousScreen] = useState<Screen | null>(null);
  const [blockedUsers, setBlockedUsers] = useState<any[]>([]);
  const [loadingBlocked, setLoadingBlocked] = useState<boolean>(false);
  const [userProfile, setUserProfile] = useState<UserProfile>(INITIAL_USER);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Record<string, Message[]>>({});
  const [selectedChatPartner, setSelectedChatPartner] = useState<ChatPartner | null>(null);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [dbSearchResults, setDbSearchResults] = useState<any[]>([]);

  const [discoverLoading, setDiscoverLoading] = useState<boolean>(false);
  const [discoverPage, setDiscoverPage] = useState<number>(1);
  const [hasMoreDiscover, setHasMoreDiscover] = useState<boolean>(true);

  // Discover Screen Filters
  const [discoverFilterGender, setDiscoverFilterGender] = useState<string>('all');
  const [discoverFilterMinAge, setDiscoverFilterMinAge] = useState<number>(18);
  const [discoverFilterMaxAge, setDiscoverFilterMaxAge] = useState<number>(100);
  const [showDiscoverFilterModal, setShowDiscoverFilterModal] = useState<boolean>(false);

  // Browser HTML5 Notifications
  const [notificationPermissionState, setNotificationPermissionState] = useState<string>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission;
    }
    return 'default';
  });

  const requestBrowserNotificationPermission = async () => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      try {
        const permission = await Notification.requestPermission();
        setNotificationPermissionState(permission);
        if (permission === 'granted') {
          showToast("🔔 Push notifications enabled successfully!", "success");
        }
      } catch (err) {
        console.warn("Failed to request notification permission:", err);
      }
    }
  };

  const triggerBrowserNotification = (title: string, body: string, iconUrl?: string) => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body,
          icon: iconUrl || IMAGES.auraLogo,
        });
      } catch (err) {
        console.warn("Could not display browser Notification:", err);
      }
    }
  };

  // Fetch matching user profiles dynamically from PostgreSQL database (no mock fallback)
  const fetchDbMatches = async (isNextPage: boolean = false) => {
    if (!auth.currentUser) return;
    const nextPage = isNextPage ? discoverPage + 1 : 1;
    if (isNextPage && !hasMoreDiscover) return;
    setDiscoverLoading(true);
    try {
      const limit = 15;
      const genderQuery = discoverFilterGender !== 'all' ? `&gender=${discoverFilterGender}` : '';
      const minAgeQuery = `&minAge=${discoverFilterMinAge}`;
      const maxAgeQuery = `&maxAge=${discoverFilterMaxAge}`;
      const res = await fetchFromBackend(`/api/users/all?limit=${limit}&page=${nextPage}${genderQuery}${minAgeQuery}${maxAgeQuery}`);
      if (res.ok) {
        const data = await res.json();
        const mapped = data.map((u: any) => {
          let photoUrl = u.photo || IMAGES.coupleBackground;
          if (u.photos && Array.isArray(u.photos) && u.photos.length > 0) {
            photoUrl = u.photos[0];
          }
          return {
            id: u.uid,
            name: u.name || u.username || 'Aura User',
            photo: photoUrl,
            photos: u.photos || [photoUrl],
            bio: u.bio || 'New member of Aura community',
            age: u.age || 25,
            username: u.username || u.uid,
            isVerified: u.isVerified,
            isSubscribed: u.isSubscribed,
            interests: u.interests ? (typeof u.interests === 'string' ? u.interests.split(',') : u.interests) : [],
            distance: u.distance,
          };
        });

        if (isNextPage) {
          setDiscoverPeople(prev => {
            const seenIds = new Set(prev.map(p => p.id));
            const filteredNew = mapped.filter((p: any) => !seenIds.has(p.id));
            return [...prev, ...filteredNew];
          });
          setDiscoverPage(nextPage);
        } else {
          setDiscoverPeople(mapped);
          setDiscoverPage(1);
          setActiveDiscoverIndex(0);
        }

        if (mapped.length < limit) {
          setHasMoreDiscover(false);
        } else {
          setHasMoreDiscover(true);
        }

        if (mapped.length > 0 && !isNextPage) {
          const initialSparks = mapped.slice(0, 5).map((m: any) => ({
            id: m.id,
            name: m.name,
            photo: m.photo,
            status: 'pending'
          }));
          setSparksList(initialSparks);
        }
      } else {
        if (!isNextPage) {
          setDiscoverPeople([]);
          setHasMoreDiscover(false);
        }
      }
    } catch (err) {
      console.warn('Could not load server profiles:', err);
      if (!isNextPage) {
        setDiscoverPeople([]);
        setHasMoreDiscover(false);
      }
    } finally {
      setDiscoverLoading(false);
    }
  };

  useEffect(() => {
    if (userRegistered && auth.currentUser) {
      fetchDbMatches(false);
    } else {
      setDiscoverPeople([]);
    }
  }, [userRegistered, auth.currentUser, userProfile.uid]);

  // DB search trigger
  useEffect(() => {
    if (chatSearchQuery.trim() === '') {
      setDbSearchResults([]);
      return;
    }
    const delayDebounceFn = setTimeout(() => {
      fetchFromBackend(`/api/users/search?q=${encodeURIComponent(chatSearchQuery)}`)
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Search failed');
        })
        .then((data) => {
          setDbSearchResults(data || []);
        })
        .catch((err) => {
          console.warn('PostgreSQL search failed:', err);
        });
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [chatSearchQuery]);

  // Polling for currently active direct chat with selected partner
  useEffect(() => {
    if (!auth.currentUser || !selectedChatPartner) {
      return;
    }

    const partnerId = selectedChatPartner.id;

    const fetchMessages = async () => {
      try {
        const res = await fetchFromBackend(`/api/messages?partnerUid=${encodeURIComponent(partnerId)}`);
        if (res.ok) {
          const data = await res.json();
          const mapped: Message[] = data.map((msg: any) => ({
            id: msg.id.toString(),
            sender: msg.senderUid === auth.currentUser?.uid ? 'user' : msg.senderUid,
            text: msg.text,
            image: msg.image,
            time: msg.timeString || new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isRead: msg.isRead,
          }));

          setChatMessages(mapped);

          setConversations((prev) => ({
            ...prev,
            [partnerId]: mapped,
          }));

          // Mark incoming unread messages as read
          const hasUnread = data.some((m: any) => m.senderUid === partnerId && !m.isRead);
          if (hasUnread) {
            fetchFromBackend('/api/messages/read', {
              method: 'PATCH',
              body: JSON.stringify({ partnerUid: partnerId })
            }).then(() => {
              fetchRecentChats();
            }).catch(e => console.warn('Failed to mark read:', e));
          }
        }
      } catch (err) {
        console.warn('Failed to poll active messages:', err);
      }
    };

    fetchMessages();

    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [selectedChatPartner, auth.currentUser]);

  // Polling for ALL messages to update the Inbox list in real-time
  useEffect(() => {
    if (!auth.currentUser || selectedChatPartner || currentScreen !== 'chat') {
      return;
    }

    const fetchAllMessages = async () => {
      try {
        const res = await fetchFromBackend('/api/messages');
        if (res.ok) {
          const data = await res.json();
          
          const grouped: Record<string, Message[]> = {};
          data.forEach((msg: any) => {
            const partnerId = msg.senderUid === auth.currentUser?.uid ? msg.receiverUid : msg.senderUid;
            const mappedMsg: Message = {
              id: msg.id.toString(),
              sender: msg.senderUid === auth.currentUser?.uid ? 'user' : msg.senderUid,
              text: msg.text,
              image: msg.image,
              time: msg.timeString || new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              isRead: msg.isRead,
            };
            if (!grouped[partnerId]) {
              grouped[partnerId] = [];
            }
            grouped[partnerId].push(mappedMsg);
          });

          setConversations(grouped);
        }
      } catch (err) {
        console.warn('Failed to poll inbox messages:', err);
      }
    };

    fetchAllMessages();

    const interval = setInterval(fetchAllMessages, 4000);
    return () => clearInterval(interval);
  }, [currentScreen, selectedChatPartner, auth.currentUser]);

  const fetchRecentChats = async () => {
    if (!auth.currentUser) return;
    try {
      const res = await fetchFromBackend('/api/messages/recents');
      if (res.ok) {
        const data = await res.json();
        setRecentChats((prevRecentChats) => {
          if (prevRecentChats && prevRecentChats.length > 0) {
            data.forEach((newChat: any) => {
              const oldChat = prevRecentChats.find((c: any) => c.uid === newChat.uid);
              const oldUnread = oldChat ? oldChat.unreadCount : 0;
              if (newChat.unreadCount > oldUnread) {
                // Trigger real browser push notification for new message!
                triggerBrowserNotification(`💬 Message from ${newChat.name}`, newChat.lastMessageText || 'Sent an attachment', newChat.photo);
              }
            });
          }
          return data;
        });
      }
    } catch (e) {
      console.warn('Failed to fetch recent chats:', e);
    }
  };

  const [dbStories, setDbStories] = useState<Story[]>([]);

  const fetchDbStories = async () => {
    if (!auth.currentUser) return;
    try {
      const res = await fetchFromBackend('/api/stories');
      if (res.ok) {
        const data = await res.json();
        const mapped: Story[] = data.map((s: any) => ({
          id: s.userUid + '_' + s.id,
          dbId: s.id,
          userUid: s.userUid,
          name: s.name || s.username || 'Aura User',
          photo: s.photo,
          userPhoto: s.userPhoto || s.photo,
          active: true,
          viewCount: s.viewCount,
          viewers: s.viewers,
          visibility: s.visibility,
        }));
        setDbStories(mapped);
      }
    } catch (err) {
      console.warn('Failed to fetch backend stories:', err);
    }
  };

  const fetchNotifications = async () => {
    if (!auth.currentUser) return;
    try {
      const res = await fetchFromBackend('/api/notifications');
      if (res.ok) {
        const data = await res.json();
        const mapped = data.map((n: any) => ({
          id: n.id,
          type: n.type,
          title: n.type === 'follow' ? 'Follow Request' : 'New Connection',
          message: n.text,
          senderId: n.senderUid,
          senderName: n.senderName || 'Someone',
          senderPhoto: n.senderPhoto || IMAGES.coupleBackground,
          senderUsername: n.senderUsername || 'aura_user',
          read: n.isRead,
          createdAt: n.createdAt,
        }));

        setNotifications((prevNotifications) => {
          if (prevNotifications && prevNotifications.length > 0) {
            const oldIds = new Set(prevNotifications.map((n: any) => n.id));
            const newUnreads = mapped.filter((n: any) => !n.read && !oldIds.has(n.id));
            newUnreads.forEach((n: any) => {
              triggerBrowserNotification("✨ Aura Notification", n.message, n.senderPhoto);
            });
          }
          return mapped;
        });
      }
    } catch (e) {
      console.warn('Failed to fetch notifications:', e);
    }
  };

  // Poll recent chats, notifications, and stories periodically
  useEffect(() => {
    if (checkingAuth) return;
    if (!auth.currentUser) return;

    fetchRecentChats();
    fetchNotifications();
    fetchDbStories();

    const interval = setInterval(() => {
      fetchRecentChats();
      fetchNotifications();
      fetchDbStories();
    }, 4000);

    return () => clearInterval(interval);
  }, [checkingAuth, auth.currentUser?.uid, currentScreen]);

  // Load selected partner relationship status on change
  useEffect(() => {
    if (!auth.currentUser || !selectedChatPartner) {
      setActiveChatPartnerProfile(null);
      return;
    }
    const fetchPartnerProfile = async () => {
      try {
        const res = await fetchFromBackend(`/api/users/profile/${selectedChatPartner.id}`);
        if (res.ok) {
          const data = await res.json();
          setActiveChatPartnerProfile(data);
        }
      } catch (e) {
        console.warn('Failed to fetch active chat partner profile:', e);
      }
    };
    fetchPartnerProfile();
  }, [selectedChatPartner, auth.currentUser]);

  const [userStories, setUserStories] = useState<Story[]>([]);
  const storyFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingStoryBase64, setPendingStoryBase64] = useState<string | null>(null);
  const [showStoryPrivacyModal, setShowStoryPrivacyModal] = useState<boolean>(false);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const [activeStoryIndex, setActiveStoryIndex] = useState<number | null>(null);
  const [storyViewerList, setStoryViewerList] = useState<Story[]>([]);
  const [activeStoryTimeLeft, setActiveStoryTimeLeft] = useState<number>(100);
  const [sparksList, setSparksList] = useState<any[]>([]);
  const [inputText, setInputText] = useState('');
  const [isElenaTyping, setIsElenaTyping] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<'yearly' | 'monthly'>('yearly');
  const [goldSuccess, setGoldShadowSuccess] = useState(false);
  const [goldUser, setGoldUser] = useState(false);
  const [saveSuccessToast, setSaveSuccessToast] = useState(false);
  const [payoutStatus, setPayoutStatus] = useState<'idle' | 'loading' | 'success'>('idle');
  const [profilePicUrls, setProfilePicUrls] = useState<string[]>([IMAGES.primaryOnboardingPic]);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [userSparks, setUserSparks] = useState(() => {
    const saved = localStorage.getItem('aura_user_sparks');
    return saved ? parseInt(saved, 10) : 5;
  });
  const [watchingAd, setWatchingAd] = useState(false);
  const [adTimeLeft, setAdTimeLeft] = useState(0);
  const [showDemoVideoAd, setShowDemoVideoAd] = useState(false);
  const [interstitialAd, setInterstitialAd] = useState<{ active: boolean; pendingAction: () => void } | null>(null);
  const [guestWarningModal, setGuestWarningModal] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };
  const [recentChats, setRecentChats] = useState<any[]>([]);
  const [activeChatPartnerProfile, setActiveChatPartnerProfile] = useState<any>(null);
  const [ownFollowersCount, setOwnFollowersCount] = useState<number>(0);
  const [ownFollowingCount, setOwnFollowingCount] = useState<number>(0);

  // Fetch own profile stats when entering Edit Profile
  useEffect(() => {
    if (currentScreen === 'edit_profile' && auth.currentUser) {
      fetchFromBackend(`/api/users/profile/${auth.currentUser.uid}`)
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Failed to fetch own profile stats');
        })
        .then((data) => {
          setOwnFollowersCount(data.followersCount || 0);
          setOwnFollowingCount(data.followingCount || 0);
        })
        .catch((e) => console.warn('Failed to load own profile stats:', e));
    }
  }, [currentScreen]);

  // Dynamic States for Discover Feed, Streaks, Home Search, and Profile Actions
  const [discoverPeople, setDiscoverPeople] = useState<any[]>(AVAILABLE_PEOPLE);
  const [activeDiscoverIndex, setActiveDiscoverIndex] = useState(0);
  const [selectedDiscoverPerson, setSelectedDiscoverPerson] = useState<any>(AVAILABLE_PEOPLE[0]);
  const [homeSearchQuery, setHomeSearchQuery] = useState('');
  const [chatStreaks, setChatStreaks] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem('aura_chat_streaks');
    return saved ? JSON.parse(saved) : { elena: 5, sarah: 2 };
  });
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileShareOpen, setProfileShareOpen] = useState(false);
  const [isPublicView, setIsPublicView] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrUrl, setQrUrl] = useState('');
  const [isBlurred, setIsBlurred] = useState(false);

  const [activePhotoIndex, setActivePhotoIndex] = useState<number>(0);
  const [fullScreenImage, setFullScreenImage] = useState<string | null>(null);
  const [publicProfileError, setPublicProfileError] = useState<boolean>(false);

  // New States for Clickable Profiles & Sparks Popup & Followers/Following List Modal
  const [sparkPopupProfile, setSparkPopupProfile] = useState<any | null>(null);
  const [followListType, setFollowListType] = useState<'followers' | 'following' | null>(null);
  const [followListUserUid, setFollowListUserUid] = useState<string>('');
  const [followListUserName, setFollowListUserName] = useState<string>('');
  const [followListUsers, setFollowListUsers] = useState<any[]>([]);
  const [followListLoading, setFollowListLoading] = useState<boolean>(false);
  const [targetProfileStats, setTargetProfileStats] = useState<{
    followersCount: number;
    followingCount: number;
    isFollowing: boolean;
  } | null>(null);

  // Helper to open any user's profile detail page
  const openUserProfile = async (uid: string) => {
    if (!uid) return;
    if (isGuest) {
      setGuestWarningModal('like');
      return;
    }
    try {
      // Find locally first to keep it super responsive
      const localPerson = discoverPeople.find(p => p.id === uid) || AVAILABLE_PEOPLE.find(p => p.id === uid);
      if (localPerson) {
        setSelectedDiscoverPerson(localPerson);
        setActivePhotoIndex(0);
        navigateTo('profile_details');
      } else {
        const res = await fetchFromBackend(`/api/users/profile/${uid}`);
        if (res.ok) {
          const data = await res.json();
          const mappedPerson = {
            id: data.uid,
            name: data.name || 'Anonymous',
            username: data.username || data.uid,
            photo: data.photo || (data.photos && data.photos[0]) || IMAGES.primaryOnboardingPic,
            photos: data.photos || [],
            bio: data.bio || 'Aura Member',
            age: data.age || 21,
            gender: data.gender || 'Not specified',
            interests: data.interests || [],
            isVerified: data.isVerified,
            location: 'Nearby',
          };
          setSelectedDiscoverPerson(mappedPerson);
          setActivePhotoIndex(0);
          navigateTo('profile_details');
        } else {
          showToast("Could not find user profile", "error");
        }
      }
    } catch (err) {
      console.error("Error opening profile:", err);
      showToast("Error opening profile", "error");
    }
  };

  // Helper to open Sparks popup preview
  const openSparkPopup = async (spark: any) => {
    if (!spark || !spark.id) return;
    const localUser = discoverPeople.find(p => p.id === spark.id) || AVAILABLE_PEOPLE.find(p => p.id === spark.id);
    if (localUser) {
      setSparkPopupProfile({ ...localUser, sparkStatus: spark.status });
    } else {
      try {
        const res = await fetchFromBackend(`/api/users/profile/${spark.id}`);
        if (res.ok) {
          const data = await res.json();
          const mappedPerson = {
            id: data.uid,
            name: data.name || 'Anonymous',
            username: data.username || data.uid,
            photo: data.photo || (data.photos && data.photos[0]) || IMAGES.primaryOnboardingPic,
            photos: data.photos || [],
            bio: data.bio || 'Aura Member',
            age: data.age || 21,
            gender: data.gender || 'Not specified',
            interests: data.interests || [],
            isVerified: data.isVerified,
            location: 'Nearby',
            sparkStatus: spark.status,
          };
          setSparkPopupProfile(mappedPerson);
        } else {
          setSparkPopupProfile({
            id: spark.id,
            name: spark.name,
            photo: spark.photo,
            photos: [spark.photo],
            bio: 'Aura Member',
            age: 21,
            sparkStatus: spark.status,
          });
        }
      } catch (e) {
        setSparkPopupProfile({
          id: spark.id,
          name: spark.name,
          photo: spark.photo,
          photos: [spark.photo],
          bio: 'Aura Member',
          age: 21,
          sparkStatus: spark.status,
        });
      }
    }
  };

  // Helper to open Followers/Following lists popup
  const openFollowList = async (type: 'followers' | 'following', uid: string, name: string) => {
    if (!uid) return;
    if (isGuest) {
      setGuestWarningModal('like');
      return;
    }
    setFollowListType(type);
    setFollowListUserUid(uid);
    setFollowListUserName(name);
    setFollowListLoading(true);
    setFollowListUsers([]);
    try {
      const res = await fetchFromBackend(`/api/follows/${type}/${uid}`);
      if (res.ok) {
        const data = await res.json();
        setFollowListUsers(data);
      } else {
        showToast(`Failed to load ${type} list`, 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(`Failed to load ${type} list`, 'error');
    } finally {
      setFollowListLoading(false);
    }
  };

  // Fetch target profile stats dynamically when on profile details page
  useEffect(() => {
    if (currentScreen === 'profile_details' && auth.currentUser) {
      const targetUser = selectedDiscoverPerson || discoverPeople[activeDiscoverIndex % discoverPeople.length];
      if (targetUser && targetUser.id) {
        fetchFromBackend(`/api/users/profile/${targetUser.id}`)
          .then((res) => {
            if (res.ok) return res.json();
            throw new Error('Failed to fetch profile stats');
          })
          .then((data) => {
            setTargetProfileStats({
              followersCount: data.followersCount || 0,
              followingCount: data.followingCount || 0,
              isFollowing: data.relationSent === 'accepted',
            });
          })
          .catch((e) => {
            console.warn('Failed to load profile stats:', e);
            const followingList = userProfile.following || [];
            const isFollowing = followingList.includes(targetUser.id);
            setTargetProfileStats({
              followersCount: targetUser.followersCount || targetUser.followers?.length || 0,
              followingCount: targetUser.followingCount || targetUser.following?.length || 0,
              isFollowing,
            });
          });
      }
    } else {
      setTargetProfileStats(null);
    }
  }, [currentScreen, selectedDiscoverPerson, activeDiscoverIndex, auth.currentUser]);

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    cancelText?: string;
    confirmText?: string;
  } | null>(null);

  useEffect(() => {
    setActivePhotoIndex(0);
  }, [selectedDiscoverPerson?.id]);

  const [mockFollowBacks, setMockFollowBacks] = useState<Record<string, boolean>>({
    elena: false,
    sarah: false,
    leo: false,
    maya: false,
    chloe: false,
    oliver: false,
    sofia: false,
    marcus: false,
  });


  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [processingNotifications, setProcessingNotifications] = useState<Record<string, boolean>>({});

  // Authentication custom states
  const [emailMode, setEmailMode] = useState<'options' | 'login' | 'signup'>('options');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Profile photo addition states & refs
  const [photoSlotToEdit, setPhotoSlotToEdit] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form setup states
  const [onboardingName, setOnboardingName] = useState('');
  const [onboardingUsername, setOnboardingUsername] = useState('');
  const [onboardingDob, setOnboardingDob] = useState({ dd: '', mm: '', yyyy: '' });
  const [onboardingGender, setOnboardingGender] = useState('');
  const [onboardingInterests, setOnboardingInterests] = useState<string[]>(['Art', 'Travel', 'Jazz']);

  const [trackingLogs, setTrackingLogs] = useState<any[]>([]);
  const [loadingTracking, setLoadingTracking] = useState<boolean>(false);

  // Helper to fetch from Express backend with Firebase ID Token
  const fetchFromBackend = async (url: string, options: RequestInit = {}) => {
    const currentUser = auth.currentUser;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    } as Record<string, string>;

    if (currentUser) {
      try {
        const token = await currentUser.getIdToken();
        headers['Authorization'] = `Bearer ${token}`;
      } catch (err) {
        console.warn('Failed to retrieve Firebase ID Token', err);
      }
    }

    return fetch(url, {
      ...options,
      headers,
    });
  };

  // Log tracking event to Postgres via Express server
  const trackUserAction = async (eventType: string, screenName?: string, details?: any) => {
    try {
      await fetchFromBackend('/api/tracking/event', {
        method: 'POST',
        body: JSON.stringify({
          eventType,
          screenName,
          details,
        }),
      });
    } catch (err) {
      console.warn('Failed to send user tracking log:', err);
    }
  };

  // Chat scroll anchor
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isElenaTyping, currentScreen]);

  // Public Routing, Deep Link Processing & Background Privacy Listeners
  useEffect(() => {
    // 1. Deep Link / Public Profile Routing
    const processPathRouting = () => {
      const path = window.location.pathname;
      const match = path.match(/^\/(u|profile)\/([a-zA-Z0-9_.-]+)/);
      if (match) {
        const username = match[2];
        fetch(`/api/public/profile/username/${username}`)
          .then((res) => {
            if (res.ok) return res.json();
            throw new Error('Public profile not found');
          })
          .then((data) => {
            setSelectedDiscoverPerson(data);
            const loggedIn = !!auth.currentUser;
            setIsPublicView(!loggedIn);
            setPublicProfileError(false);
            setCurrentScreen('profile_details');
          })
          .catch((err) => {
            console.error(err);
            setPublicProfileError(true);
            setIsPublicView(true);
            setSelectedDiscoverPerson(null);
            setCurrentScreen('profile_details');
            showToast('Could not find public profile', 'error');
          });
      } else {
        setPublicProfileError(false);
      }
    };

    processPathRouting();

    const handlePopState = () => {
      processPathRouting();
    };

    window.addEventListener('popstate', handlePopState);

    // 2. Background Privacy Listeners (Focus/Blur/VisibilityChange)
    const handleBlur = () => {
      setIsBlurred(true);
    };
    const handleFocus = () => {
      setIsBlurred(false);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setIsBlurred(true);
      } else {
        setIsBlurred(false);
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Keep currentScreen in localStorage so refresh works flawlessly
  useEffect(() => {
    if (currentScreen !== 'welcome' && currentScreen !== 'signin' && currentScreen !== 'onboarding_basics' && currentScreen !== 'onboarding_interests' && currentScreen !== 'onboarding_photos') {
      localStorage.setItem('aura_current_screen', currentScreen);
    }
  }, [currentScreen]);

  // Record story view when activeStoryIndex is set
  useEffect(() => {
    if (activeStoryIndex !== null && storyViewerList[activeStoryIndex]) {
      const story = storyViewerList[activeStoryIndex];
      if (story.userUid && story.userUid !== auth.currentUser?.uid) {
        const rawStoryId = story.id.toString().includes('_') ? story.id.toString().split('_')[1] : story.id;
        fetchFromBackend(`/api/stories/${rawStoryId}/view`, {
          method: 'POST',
        }).catch(err => console.warn('Failed to record story view:', err));
      }
    }
  }, [activeStoryIndex, storyViewerList, auth.currentUser]);

  // Story Timer
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (activeStoryIndex !== null) {
      setActiveStoryTimeLeft(100);
      const interval = 40; // 40ms * 100 = 4 seconds total story view
      timer = setInterval(() => {
        setActiveStoryTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            // Auto-advance or close using dynamic storyViewerList
            if (activeStoryIndex < storyViewerList.length - 1) {
              setActiveStoryIndex(activeStoryIndex + 1);
            } else {
              setActiveStoryIndex(null);
            }
            return 100;
          }
          return prev - 1;
        });
      }, interval);
    }
    return () => clearInterval(timer);
  }, [activeStoryIndex, storyViewerList.length]);

  // Screen/Guest refs to prevent unstable listener re-registrations
  const currentScreenRef = useRef(currentScreen);
  currentScreenRef.current = currentScreen;
  const isGuestRef = useRef(isGuest);
  isGuestRef.current = isGuest;

  // Synchronize states to localStorage
  useEffect(() => {
    localStorage.setItem('aura_is_guest', String(isGuest));
  }, [isGuest]);

  useEffect(() => {
    localStorage.setItem('aura_user_registered', String(userRegistered));
  }, [userRegistered]);



  useEffect(() => {
    localStorage.setItem('aura_user_sparks', String(userSparks));
  }, [userSparks]);

  // Handle ad playback progress reward tick
  useEffect(() => {
    if (watchingAd && adTimeLeft > 0) {
      const timer = setTimeout(() => {
        setAdTimeLeft((prev) => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    } else if (watchingAd && adTimeLeft === 0) {
      setWatchingAd(false);
      setUserSparks((prev) => prev + 5);
      showToast("✨ Ad completed! You earned 5 Sparks.", "success");
    }
  }, [watchingAd, adTimeLeft]);

  // Reset sparks helper
  const resetSparksList = () => {
    setSparksList((prev) =>
      prev.map((spark) => ({ ...spark, status: 'pending' }))
    );
    showToast("✨ Spark requests have been reset to pending!", "success");
  };

  const checkUserProfile = async (firebaseUser: any) => {
    try {
      const token = await firebaseUser.getIdToken();
      
      // 1. Fetch from PostgreSQL backend
      let pgData: any = null;
      let pgResOk = false;
      try {
        const pgRes = await fetch('/api/users/profile', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (pgRes.ok) {
          pgData = await pgRes.json();
          pgResOk = true;
        }
      } catch (e) {
        console.warn('Postgres profile fetch failed:', e);
      }

      if (pgResOk && pgData) {
        const interestsArray = pgData.interests ? pgData.interests.split(',') : [];
        let parsedPhotos: string[] = [];
        if (pgData.photos) {
          try {
            parsedPhotos = typeof pgData.photos === 'string' ? JSON.parse(pgData.photos) : pgData.photos;
          } catch (e) {
            console.warn('Failed to parse photos column:', e);
          }
        }
        if (!Array.isArray(parsedPhotos) || parsedPhotos.length === 0) {
          parsedPhotos = pgData.photo ? [pgData.photo] : [IMAGES.primaryOnboardingPic];
        }

        const profileData: UserProfile = {
          ...pgData,
          username: pgData.username || pgData.uid,
          photos: parsedPhotos,
          interests: interestsArray,
          following: pgData.following || [],
          followers: pgData.followers || [],
        };
        setUserProfile(profileData);
        setProfilePicUrls(parsedPhotos);
        setUserRegistered(true);
        fetchDbStories();
        fetchNotifications();

        const path = window.location.pathname;
        const isPublicPath = path.match(/^\/(u|profile)\/([a-zA-Z0-9_.-]+)/);
        if (!isPublicPath) {
          const savedScreen = localStorage.getItem('aura_current_screen') as Screen;
          if (savedScreen && savedScreen !== 'welcome' && savedScreen !== 'signin' && savedScreen !== 'onboarding_basics' && savedScreen !== 'onboarding_interests' && savedScreen !== 'onboarding_photos') {
            setCurrentScreen(savedScreen);
          } else if (['welcome', 'signin', 'onboarding_basics', 'onboarding_interests', 'onboarding_photos'].includes(currentScreenRef.current)) {
            setCurrentScreen('discover');
          }
        }

        fetch('/api/tracking/event', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${token}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ 
            eventType: 'login_event', 
            screenName: 'welcome', 
            details: { source: 'postgres' } 
          })
        }).catch(() => {});

        return true;
      }

      // 2. Try Firestore fallback
      const docRef = doc(db, 'users', firebaseUser.uid);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data() as UserProfile;
        setUserProfile(data);
        if (data.photos && data.photos.length > 0) {
          setProfilePicUrls(data.photos);
        }
        setUserRegistered(true);
        fetchDbStories();
        fetchNotifications();

        fetch('/api/users/profile', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${token}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({
            ...data,
            photo: data.photos && data.photos.length > 0 ? data.photos[0] : null,
            photos: data.photos || [],
            interests: data.interests ? data.interests.join(',') : '',
          }),
        }).catch(() => {});

        const path = window.location.pathname;
        const isPublicPath = path.match(/^\/(u|profile)\/([a-zA-Z0-9_.-]+)/);
        if (!isPublicPath) {
          const savedScreen = localStorage.getItem('aura_current_screen') as Screen;
          if (savedScreen && savedScreen !== 'welcome' && savedScreen !== 'signin' && savedScreen !== 'onboarding_basics' && savedScreen !== 'onboarding_interests' && savedScreen !== 'onboarding_photos') {
            setCurrentScreen(savedScreen);
          } else if (['welcome', 'signin', 'onboarding_basics', 'onboarding_interests', 'onboarding_photos'].includes(currentScreenRef.current)) {
            setCurrentScreen('discover');
          }
        }

        return true;
      } else {
        setUserRegistered(false);
        if (['welcome', 'signin'].includes(currentScreenRef.current)) {
          setCurrentScreen('onboarding_basics');
        }
        return false;
      }
    } catch (error: any) {
      console.warn('Network or DB read failed completely, checking offline fallback:', error);
      const offlineRegistered = localStorage.getItem('aura_user_registered') === 'true';
      if (offlineRegistered) {
        setUserRegistered(true);
        fetchDbStories();
        fetchNotifications();
        
        const path = window.location.pathname;
        const isPublicPath = path.match(/^\/(u|profile)\/([a-zA-Z0-9_.-]+)/);
        if (!isPublicPath) {
          const savedScreen = localStorage.getItem('aura_current_screen') as Screen;
          if (savedScreen && savedScreen !== 'welcome' && savedScreen !== 'signin' && savedScreen !== 'onboarding_basics' && savedScreen !== 'onboarding_interests' && savedScreen !== 'onboarding_photos') {
            setCurrentScreen(savedScreen);
          } else if (['welcome', 'signin'].includes(currentScreenRef.current)) {
            setCurrentScreen('discover');
          }
        }
        return true;
      } else {
        setUserRegistered(false);
        const path = window.location.pathname;
        const isPublicPath = path.match(/^\/(u|profile)\/([a-zA-Z0-9_.-]+)/);
        if (!isPublicPath && ['welcome', 'signin'].includes(currentScreenRef.current)) {
          setCurrentScreen('onboarding_basics');
        }
        return false;
      }
    }
  };

  // Listen to Firebase Auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      const isPublicPath = window.location.pathname.match(/^\/(u|profile)\/([a-zA-Z0-9_.-]+)/);
      if (firebaseUser) {
        setIsGuest(false);
        await checkUserProfile(firebaseUser);
      } else {
        if (isGuestRef.current || isPublicPath) {
          if (isPublicPath) {
            setIsGuest(true);
            setIsPublicView(true);
            setCurrentScreen('profile_details');
          } else {
            const savedScreen = localStorage.getItem('aura_current_screen') as Screen;
            if (savedScreen && savedScreen !== 'welcome' && savedScreen !== 'signin' && savedScreen !== 'onboarding_basics' && savedScreen !== 'onboarding_interests' && savedScreen !== 'onboarding_photos') {
              setCurrentScreen(savedScreen);
            } else {
              setCurrentScreen('discover');
            }
          }
        } else {
          setUserProfile(INITIAL_USER);
          setProfilePicUrls([IMAGES.primaryOnboardingPic]);
          setUserRegistered(false);
          setCurrentScreen('welcome');
        }
      }
      setCheckingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  // Save profile to PostgreSQL database and Firestore as backup
  const saveProfileToFirestore = async (updatedProfile?: UserProfile) => {
    const currentUser = auth.currentUser;
    const profileToSave = updatedProfile || userProfile;

    // Save to PostgreSQL via Express backend
    try {
      await fetchFromBackend('/api/users/profile', {
        method: 'POST',
        body: JSON.stringify({
          email: profileToSave.email,
          name: profileToSave.name,
          username: profileToSave.username || null,
          photo: profileToSave.photos ? profileToSave.photos[0] : null,
          photos: profileToSave.photos || [],
          bio: profileToSave.bio,
          age: profileToSave.age,
          gender: profileToSave.gender || null,
          interests: profileToSave.interests ? profileToSave.interests.join(',') : '',
          role: profileToSave.role || 'user',
          isSubscribed: profileToSave.isSubscribed || false,
        }),
      });
    } catch (err) {
      console.warn('Failed to save profile to PostgreSQL database:', err);
    }

    // Backup to Firestore
    if (currentUser) {
      const docRef = doc(db, 'users', currentUser.uid);
      try {
        await setDoc(docRef, {
          ...profileToSave,
          updatedAt: new Date().toISOString()
        });
      } catch (error: any) {
        console.warn('Firestore backup write failed:', error);
      }
    }

    setUserProfile(profileToSave);
    setUserRegistered(true);
    setSaveSuccessToast(true);
    setTimeout(() => setSaveSuccessToast(false), 2500);
  };

  // Helper to format Auth / Firestore errors nicely for the user
  const formatAuthError = (error: any, actionName: string) => {
    const code = error?.code || '';
    const message = error?.message || '';
    if (code === 'auth/operation-not-allowed' || message.includes('operation-not-allowed')) {
      return `Firebase Error: 'Email/Password' or 'Google' sign-in is not enabled in your Firebase Authentication Console. Please enable them, or go back and click 'Explore as Guest'!`;
    }
    if (message.includes('permission') || code.includes('permission')) {
      return `Firebase Error: Missing or insufficient Firestore database permissions. Please verify your firestore.rules configuration or try refreshing.`;
    }
    return message || `${actionName} failed`;
  };

  // Google Sign In handler
  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    setAuthError('');
    try {
      if (Capacitor.isNativePlatform()) {
        const result = await FirebaseAuthentication.signInWithGoogle();
        const idToken = result.credential?.idToken;
        if (!idToken) {
          throw new Error('No idToken returned from native Google Sign-In');
        }
        const credential = GoogleAuthProvider.credential(idToken);
        const firebaseUserResult = await signInWithCredential(auth, credential);
        if (firebaseUserResult.user) {
          await checkUserProfile(firebaseUserResult.user);
        }
      } else {
        const provider = new GoogleAuthProvider();
        const result = await signInWithPopup(auth, provider);
        if (result.user) {
          // Successful login - check profile from database
          await checkUserProfile(result.user);
        }
      }
    } catch (error: any) {
      console.error(error);
      setAuthError(formatAuthError(error, 'Google Sign In'));
    } finally {
      setAuthLoading(false);
    }
  };

  // Email Sign In handler
  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setAuthError('Please fill in all fields.');
      return;
    }
    setAuthLoading(true);
    setAuthError('');
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      if (result.user) {
        // Successful login - check profile from database
        await checkUserProfile(result.user);
      }
    } catch (error: any) {
      console.error(error);
      setAuthError(formatAuthError(error, 'Email Sign In'));
    } finally {
      setAuthLoading(false);
    }
  };

  // Email Sign Up handler
  const handleEmailSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setAuthError('Please fill in all fields.');
      return;
    }
    if (password.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }
    setAuthLoading(true);
    setAuthError('');
    try {
      const result = await createUserWithEmailAndPassword(auth, email, password);
      if (result.user) {
        // Sign up success, navigate to onboarding basics
        setUserRegistered(false);
        setCurrentScreen('onboarding_basics');
      }
    } catch (error: any) {
      console.error(error);
      setAuthError(formatAuthError(error, 'Email Sign Up'));
    } finally {
      setAuthLoading(false);
    }
  };

  // Logout handler
  const handleLogout = async () => {
    try {
      await signOut(auth);
      // Clear all Aura-specific localStorage keys
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('aura_')) {
          localStorage.removeItem(key);
        }
      });
      setIsGuest(false);
      setEmailMode('options');
      setEmail('');
      setPassword('');
      setAuthError('');
      setCurrentScreen('welcome');
    } catch (error) {
      console.error(error);
      // Clear all Aura-specific localStorage keys on fallback too
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('aura_')) {
          localStorage.removeItem(key);
        }
      });
      setIsGuest(false);
      setEmailMode('options');
      setEmail('');
      setPassword('');
      setAuthError('');
      setCurrentScreen('welcome');
    }
  };

  // Fetch blocked users list from PostgreSQL
  useEffect(() => {
    if (currentScreen === 'edit_profile' && auth.currentUser) {
      setLoadingBlocked(true);
      fetchFromBackend('/api/users/blocked')
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Failed to fetch blocked users');
        })
        .then((data) => {
          setBlockedUsers(data || []);
          setLoadingBlocked(false);
        })
        .catch((err) => {
          console.warn('PostgreSQL blocked users fetch failed:', err);
          setLoadingBlocked(false);
        });
    }
  }, [currentScreen]);

  const handleUnblockUser = async (blockedUid: string) => {
    try {
      const res = await fetchFromBackend('/api/users/unblock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockedUid }),
      });
      if (res.ok) {
        setBlockedUsers((prev) => prev.filter((u) => u.uid !== blockedUid));
        showToast('User unblocked successfully!', 'success');
        
        // Also reload discovery people, just in case they are now visible!
        fetchDbMatches(false);
      } else {
        const errData = await res.json();
        showToast(errData.error || 'Failed to unblock user', 'error');
      }
    } catch (err) {
      console.error('Error unblocking user:', err);
      showToast('Error unblocking user', 'error');
    }
  };

  const handleDeleteAccount = async () => {
    const confirmed = window.confirm("⚠️ Are you absolutely sure you want to permanently delete your Aura account? This action is IRREVERSIBLE and all your matches, chats, stories, and profile data will be permanently erased.");
    if (!confirmed) return;

    try {
      // 1. Delete from PostgreSQL
      const pgRes = await fetchFromBackend('/api/users/delete', { method: 'POST' });
      if (!pgRes.ok) {
        throw new Error("Failed to delete database records");
      }

      // 2. Delete from Firestore
      const currentUser = auth.currentUser;
      if (currentUser) {
        try {
          const { deleteDoc, doc } = await import('firebase/firestore');
          await deleteDoc(doc(db, 'users', currentUser.uid));
        } catch (e) {
          console.warn("Firestore user document deletion failed (might not exist):", e);
        }
      }

      // 3. Delete from Firebase Auth
      if (currentUser) {
        try {
          await currentUser.delete();
        } catch (authErr: any) {
          console.warn("Firebase Auth delete failed (requires recent login). We will perform standard logout and backend deletion anyway:", authErr);
          await auth.signOut();
        }
      }

      // 4. Logout and clear local storage
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('aura_')) {
          localStorage.removeItem(key);
        }
      });
      setIsGuest(false);
      setUserProfile(INITIAL_USER);
      setUserRegistered(false);
      setCurrentScreen('welcome');
      showToast("Your account has been deleted permanently.", "success");
    } catch (err: any) {
      console.error("Account deletion failed:", err);
      showToast("Account deletion failed. Please try again later.", "error");
    }
  };

  const downloadMyData = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(userProfile, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `aura_data_${userProfile.username || 'user'}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast("✨ Your Aura profile data has been downloaded successfully!", "success");
  };

  const togglePublicProfile = async () => {
    const newVal = !(userProfile as any).publicProfileLink;
    const updated = { ...userProfile, publicProfileLink: newVal };
    setUserProfile(updated);
    await saveProfileToFirestore(updated);
    showToast(`Public Profile Link ${newVal ? 'enabled' : 'disabled'}!`, 'success');
  };

  // Local photo upload file selection handler
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || photoSlotToEdit === null) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64String = event.target?.result as string;
      if (base64String) {
        const compressedBase64 = await compressImage(base64String);
        
        setProfilePicUrls((prev) => {
          const updated = [...prev];
          while (updated.length <= photoSlotToEdit) {
            updated.push('');
          }
          updated[photoSlotToEdit] = compressedBase64;
          return updated;
        });
        
        setUserProfile((prev) => {
          const updatedPhotos = prev.photos ? [...prev.photos] : [];
          while (updatedPhotos.length <= photoSlotToEdit) {
            updatedPhotos.push('');
          }
          updatedPhotos[photoSlotToEdit] = compressedBase64;
          const updated = {
            ...prev,
            photos: updatedPhotos
          };
          // If on edit_profile screen, also automatically trigger Firestore update
          if (currentScreen === 'edit_profile') {
            saveProfileToFirestore(updated);
          }
          return updated;
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const postPendingStory = async (visibility: 'public' | 'followers') => {
    if (!pendingStoryBase64) return;
    try {
      showToast('Posting story...', 'info');
      const res = await fetchFromBackend('/api/stories', {
        method: 'POST',
        body: JSON.stringify({ photo: pendingStoryBase64, visibility }),
      });

      if (res.ok) {
        showToast('Story posted successfully!', 'success');
        // Refresh dbStories
        const storiesRes = await fetchFromBackend('/api/stories');
        if (storiesRes.ok) {
          const data = await storiesRes.json();
          const mapped: Story[] = data.map((s: any) => ({
            id: s.userUid + '_' + s.id,
            dbId: s.id,
            userUid: s.userUid,
            name: s.name || s.username || 'Aura User',
            photo: s.photo,
            userPhoto: s.userPhoto || s.photo,
            active: true,
            viewCount: s.viewCount,
            viewers: s.viewers,
            visibility: s.visibility,
          }));
          setDbStories(mapped);
          
          // Automatically open our own story
          const ownStories = mapped.filter(s => s.userUid === auth.currentUser?.uid);
          if (ownStories.length > 0) {
            setStoryViewerList(ownStories);
            setActiveStoryIndex(0);
          }
        }
      } else {
        showToast('Failed to post story.', 'error');
      }
    } catch (err) {
      console.error('Failed to post story:', err);
      showToast('Failed to post story.', 'error');
    } finally {
      setPendingStoryBase64(null);
      setShowStoryPrivacyModal(false);
    }
  };

  // Local story upload file selection handler
  const handleStoryUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64String = event.target?.result as string;
      if (base64String) {
        showToast('Compressing story...', 'info');
        let compressedBase64 = base64String;
        try {
          if (file.type.startsWith('video/')) {
            compressedBase64 = await compressVideo(base64String);
          } else {
            compressedBase64 = await compressImage(base64String, 500, 700, 0.75); // stories can be slightly taller
          }
          
          setPendingStoryBase64(compressedBase64);
          setShowStoryPrivacyModal(true);
        } catch (err) {
          console.error('Failed to compress story:', err);
          showToast('Failed to compress story.', 'error');
        }
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Screenshot detection and notification handler
  const lastScreenshotTimeRef = useRef<number>(0);

  const triggerScreenshotDetection = async (targetContext: 'chat' | 'profile' | 'story') => {
    if (Date.now() - lastScreenshotTimeRef.current < 3000) return;
    
    let partnerId = '';
    let partnerName = '';

    if (targetContext === 'chat' && selectedChatPartner) {
      partnerId = selectedChatPartner.id;
      partnerName = selectedChatPartner.name;
    } else if (targetContext === 'story' && activeStoryIndex !== null && storyViewerList[activeStoryIndex]) {
      const story = storyViewerList[activeStoryIndex];
      if (story.userUid && story.userUid !== auth.currentUser?.uid) {
        partnerId = story.userUid;
        partnerName = story.name;
      }
    } else if (targetContext === 'profile' && selectedDiscoverPerson) {
      partnerId = selectedDiscoverPerson.id;
      partnerName = selectedDiscoverPerson.name;
    }

    if (!partnerId || !auth.currentUser) return;
    lastScreenshotTimeRef.current = Date.now();

    const myName = userProfile.name || 'Someone';
    let alertText = '';
    if (targetContext === 'chat') {
      alertText = `📸 ${myName} took a screenshot of the chat`;
    } else if (targetContext === 'story') {
      alertText = `📸 ${myName} took a screenshot of your story`;
    } else if (targetContext === 'profile') {
      alertText = `📸 ${myName} took a screenshot of your profile`;
    }

    showToast(`Screenshot detected: Sent a notification to ${partnerName || 'user'}`, 'info');

    try {
      // 1. Post system screenshot alert message in chat
      await fetchFromBackend('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          receiverUid: partnerId,
          text: alertText,
          timeString: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }),
      });

      // 2. Send database notification
      await fetchFromBackend('/api/notifications', {
        method: 'POST',
        body: JSON.stringify({
          receiverUid: partnerId,
          type: 'system',
          text: alertText,
        }),
      });

      // 3. Immediately refresh current chat messages if viewing the same partner
      if (selectedChatPartner && selectedChatPartner.id === partnerId) {
        const res = await fetchFromBackend(`/api/messages?partnerUid=${encodeURIComponent(partnerId)}`);
        if (res.ok) {
          const data = await res.json();
          const mapped: Message[] = data.map((msg: any) => ({
            id: msg.id.toString(),
            sender: msg.senderUid === auth.currentUser?.uid ? 'user' : msg.senderUid,
            text: msg.text,
            image: msg.image,
            time: msg.timeString || new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isRead: msg.isRead,
          }));
          setChatMessages(mapped);
        }
      }
    } catch (err) {
      console.warn('Failed to dispatch screenshot notification:', err);
    }
  };

  useEffect(() => {
    const handleScreenshotEvents = () => {
      let context: 'chat' | 'profile' | 'story' = 'profile';
      if (currentScreen === 'chat') {
        context = 'chat';
      } else if (activeStoryIndex !== null) {
        context = 'story';
      } else if (currentScreen === 'profile_details') {
        context = 'profile';
      }
      
      triggerScreenshotDetection(context);
    };

    // Print screen / beforeprint hook (Standard Desktop Print & screenshot triggers)
    window.addEventListener('beforeprint', handleScreenshotEvents);

    // Shortcut keyup/keydown hook
    const handleKeys = (e: KeyboardEvent) => {
      const isMacScreenshot = e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key);
      const isWinScreenshot = e.key === 'PrintScreen' || (e.key === 's' && e.metaKey && e.shiftKey);
      if (isMacScreenshot || isWinScreenshot) {
        handleScreenshotEvents();
      }
    };
    window.addEventListener('keydown', handleKeys);

    // Page Visibility and Focus changes for mobile screenshot heuristics
    let lastBlurTime = 0;
    const handleBlur = () => {
      lastBlurTime = Date.now();
    };
    
    const handleFocus = () => {
      const focusDelay = Date.now() - lastBlurTime;
      if (focusDelay < 1500 && document.visibilityState === 'visible') {
        handleScreenshotEvents();
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('beforeprint', handleScreenshotEvents);
      window.removeEventListener('keydown', handleKeys);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, [currentScreen, selectedChatPartner, activeStoryIndex, storyViewerList, selectedDiscoverPerson]);

  // Chat image attachment upload handler
  const handleChatImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const partnerId = selectedChatPartner ? selectedChatPartner.id : 'elena';

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64String = event.target?.result as string;
      if (base64String) {
        const compressedBase64 = await compressImage(base64String, 400, 400, 0.7);
        
        const newMsg: Message = {
          id: Date.now().toString(),
          sender: 'user',
          image: compressedBase64,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };

        setChatMessages((prev) => [...prev, newMsg]);
        setConversations((prev) => ({
          ...prev,
          [partnerId]: [...(prev[partnerId] || []), newMsg],
        }));

        // Save image message to PostgreSQL database
        fetchFromBackend('/api/messages', {
          method: 'POST',
          body: JSON.stringify({
            receiverUid: partnerId,
            image: compressedBase64,
            timeString: newMsg.time,
          }),
        }).catch((err) => console.warn('Failed to save user image msg to PostgreSQL:', err));
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Send message handler
  const handleSendMessage = () => {
    if (!inputText.trim()) return;

    const partnerId = selectedChatPartner ? selectedChatPartner.id : null;
    if (!partnerId) return;

    // Auto-mutual follow when sending a message to anyone
    const following = userProfile.following || [];
    if (!following.includes(partnerId)) {
      const updatedFollowing = [...following, partnerId];
      const updatedProfile = { ...userProfile, following: updatedFollowing };
      setUserProfile(updatedProfile);
      saveProfileToFirestore(updatedProfile);
    }
    if (!mockFollowBacks[partnerId]) {
      setMockFollowBacks((prev) => ({ ...prev, [partnerId]: true }));
    }

    const newMsg: Message = {
      id: Date.now().toString(),
      sender: 'user',
      text: inputText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setChatMessages((prev) => [...prev, newMsg]);
    setConversations((prev) => ({
      ...prev,
      [partnerId]: [...(prev[partnerId] || []), newMsg],
    }));

    setChatStreaks((prev) => {
      const currentVal = prev[partnerId] || 0;
      const newVal = currentVal + 1;
      const updated = { ...prev, [partnerId]: newVal };
      localStorage.setItem('aura_chat_streaks', JSON.stringify(updated));
      return updated;
    });

    setInputText('');

    // Save user message to PostgreSQL database
    fetchFromBackend('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        receiverUid: partnerId,
        text: newMsg.text,
        timeString: newMsg.time,
      }),
    }).then(async (res) => {
      if (!res.ok) {
        if (res.status === 403) {
          try {
            const errData = await res.json();
            showToast(errData.error || 'Follow to message this user.', 'error');
          } catch (e) {
            showToast('Message gating active. Follow them first.', 'error');
          }
          // Rollback local states
          setChatMessages((prev) => prev.filter(m => m.id !== newMsg.id));
          setConversations((prev) => {
            const partnerMsgs = prev[partnerId] || [];
            return {
              ...prev,
              [partnerId]: partnerMsgs.filter(m => m.id !== newMsg.id)
            };
          });
        } else {
          showToast('Failed to deliver message.', 'error');
        }
      } else {
        fetchRecentChats();
      }
    }).catch((e) => {
      console.warn('Failed to save user msg to PostgreSQL:', e);
      showToast('Delivery failed: offline.', 'error');
    });
  };

  // Onboarding interests selection toggle
  const handleToggleInterest = (interestName: string) => {
    if (onboardingInterests.includes(interestName)) {
      setOnboardingInterests((prev) => prev.filter((i) => i !== interestName));
    } else {
      setOnboardingInterests((prev) => [...prev, interestName]);
    }
  };

  // Spark accept/decline action simulation
  const handleSparkAction = (id: string, action: 'accept' | 'decline') => {
    setSparksList((prev) =>
      prev.map((spark) => {
        if (spark.id === id) {
          return { ...spark, status: action === 'accept' ? 'accepted' : 'declined' };
        }
        return spark;
      })
    );
  };

  const toggleFollowUser = (personId: string) => {
    const following = userProfile.following || [];
    const isFollowing = following.includes(personId);
    const updatedFollowing = isFollowing
      ? following.filter((id) => id !== personId)
      : [...following, personId];

    const updatedProfile = { ...userProfile, following: updatedFollowing };
    setUserProfile(updatedProfile);
    saveProfileToFirestore(updatedProfile);

    // Unlocking mutual follow state immediately for offline responsiveness
    setMockFollowBacks((prev) => ({ ...prev, [personId]: !isFollowing }));

    if (!isFollowing) {
      // Create a nice mutual connection notification from this user
      const partner = AVAILABLE_PEOPLE.find((p) => p.id === personId) || {
        id: personId,
        name: personId.charAt(0).toUpperCase() + personId.slice(1),
        photo: IMAGES.coupleBackground,
        username: personId,
      };

      const newNotif: AppNotification = {
        id: `notif_${Date.now()}_${personId}`,
        type: 'follow',
        title: 'New Connection! 💖',
        message: `${partner.name} (@${partner.username || personId}) followed you back! You can now start messaging them.`,
        senderId: personId,
        senderName: partner.name,
        senderPhoto: partner.photo,
        senderUsername: partner.username || personId,
        read: false,
        createdAt: new Date().toISOString(),
        canFollowBack: false
      };
      setNotifications((prev) => [newNotif, ...prev]);
    }

    // Save swipe and match to PostgreSQL
    const action = isFollowing ? 'pass' : 'like';
    fetchFromBackend('/api/swipes', {
      method: 'POST',
      body: JSON.stringify({
        receiverUid: personId,
        action,
      }),
    })
    .then((res) => {
      if (res.ok) return res.json();
      throw new Error('Failed to record swipe in PostgreSQL');
    })
    .then((data) => {
      if (data.isMatch) {
        setMockFollowBacks((prev) => ({ ...prev, [personId]: true }));
      }
    })
    .catch((err) => console.warn('PostgreSQL swipe recording failed:', err));
  };

  const handleSwipe = (direction: 'like' | 'dislike' | 'superlike') => {
    if (isGuest) {
      setGuestWarningModal('like');
      return;
    }
    
    const activePerson = discoverPeople[activeDiscoverIndex % discoverPeople.length] || AVAILABLE_PEOPLE[0];
    
    const proceedSwipeVisual = () => {
      setActiveDiscoverIndex((prev) => {
        const nextIndex = prev + 1;
        // Trigger infinite loading when we are within 2 profiles of the end
        if (nextIndex >= discoverPeople.length - 2 && hasMoreDiscover && !discoverLoading) {
          fetchDbMatches(true);
        }
        return nextIndex;
      });

      if (direction === 'like' || direction === 'superlike') {
        navigateTo('spark_match');
      }
    };

    if (direction === 'like' || direction === 'superlike') {
      // Follow the user immediately (swipe recording logic is not changed)
      toggleFollowUser(activePerson.id);
    }

    if (DEMO_ADS_ENABLED) {
      setInterstitialAd({
        active: true,
        pendingAction: proceedSwipeVisual
      });
    } else {
      proceedSwipeVisual();
    }
  };

  const isMutualFollower = (partnerId: string) => {
    const following = userProfile.following || [];
    return following.includes(partnerId);
  };

  // Screen navigator helper
  const navigateTo = (screen: Screen) => {
    if (isGuest) {
      if (['edit_profile', 'onboarding_basics', 'onboarding_interests', 'onboarding_photos'].includes(screen)) {
        setGuestWarningModal('profile');
        return;
      }
      if (screen === 'spark_match') {
        setGuestWarningModal('like');
        return;
      }
      if (screen === 'chat') {
        setGuestWarningModal('message');
        return;
      }
    }
    if (currentScreen !== screen) {
      setPreviousScreen(currentScreen);
    }
    setCurrentScreen(screen);
    localStorage.setItem('aura_current_screen', screen);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    // Log tracking event to PostgreSQL
    trackUserAction('page_view', screen);
  };

  // Fetch tracking logs from PostgreSQL database when entering Edit Profile (Admin Only)
  useEffect(() => {
    if (currentScreen === 'edit_profile' && (userProfile as any).role === 'admin') {
      setLoadingTracking(true);
      fetchFromBackend('/api/tracking/history')
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Failed to fetch user tracking records');
        })
        .then((data) => {
          setTrackingLogs(data || []);
          setLoadingTracking(false);
        })
        .catch((err) => {
          console.warn('PostgreSQL tracking history load failed:', err);
          setLoadingTracking(false);
        });
    }
  }, [currentScreen, userProfile]);

  const isAppScreen = ['discover', 'stories', 'edit_profile', 'chat', 'notifications', 'creator_monetization', 'profile_details', 'aura_gold', 'spark_match'].includes(currentScreen);
  const showDesktopLayout = windowWidth >= 768 && isAppScreen;

  const renderAppLayout = (children: React.ReactNode) => {
    if (showDesktopLayout) {
      return (
        <div className="relative w-full h-full bg-white overflow-hidden flex text-[#111d23] select-none">
          {/* Left Sidebar Layout */}
          <div className={`h-full border-r border-slate-100 bg-white flex flex-col shrink-0 ${windowWidth >= 1024 ? 'w-[360px] lg:w-[385px]' : 'w-[72px]'}`}>
            {/* Sidebar Header */}
            <div className="h-16 border-b border-slate-100 flex items-center px-4 justify-between bg-slate-50 flex-shrink-0">
              <button 
                type="button"
                onClick={() => { setSelectedChatPartner(null); navigateTo('edit_profile'); }}
                className="flex items-center gap-3 active:scale-95 transition-transform cursor-pointer"
                title="Edit Profile"
              >
                <div className="w-9 h-9 rounded-full overflow-hidden bg-slate-100 border border-slate-200 shrink-0">
                  <ProfileImage src={userProfile.photos?.[0]} name={userProfile.name} className="w-full h-full object-cover" />
                </div>
                {windowWidth >= 1024 && (
                  <div className="flex flex-col text-left min-w-0">
                    <span className="text-xs font-bold text-slate-800 leading-none truncate max-w-[120px]">{userProfile.name}</span>
                    <span className="text-[10px] text-primary font-mono font-bold leading-none mt-1">@{userProfile.username || 'user'}</span>
                  </div>
                )}
              </button>

              <div className={`flex items-center gap-1.5 ${windowWidth < 1024 ? 'hidden' : ''}`}>
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('stories'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors cursor-pointer ${currentScreen === 'stories' ? 'text-primary bg-rose-50/40' : 'text-slate-400'}`}
                  title="Home Feed"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'stories' ? 'fill-icon' : ''}`}>home</span>
                </button>
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('discover'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors cursor-pointer ${currentScreen === 'discover' ? 'text-primary bg-rose-50/40' : 'text-slate-400'}`}
                  title="Discover Matches"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'discover' ? 'fill-icon' : ''}`}>explore</span>
                </button>
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('chat'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors relative cursor-pointer ${currentScreen === 'chat' ? 'text-primary bg-rose-50/40' : 'text-slate-400'}`}
                  title="Chat Inbox"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'chat' ? 'fill-icon' : ''}`}>chat_bubble</span>
                  {recentChats.some(c => c.unreadCount > 0) && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full animate-pulse"></span>
                  )}
                </button>
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('notifications'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors relative cursor-pointer ${currentScreen === 'notifications' ? 'text-primary bg-rose-50/40' : 'text-slate-400'}`}
                  title="Notifications"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'notifications' ? 'fill-icon' : ''}`}>notifications</span>
                  {notifications.some(n => !n.read) && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full"></span>
                  )}
                </button>
                <button
                  onClick={handleLogout}
                  className="p-2 rounded-full hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
                  title="Log Out"
                >
                  <span className="material-symbols-outlined text-[20px]">logout</span>
                </button>
              </div>
            </div>

            {/* Sidebar Navigation for Tablet (Icon Rail view stacked vertically below header) */}
            {windowWidth < 1024 && (
              <div className="flex flex-col items-center gap-4 py-4 bg-slate-50/45 border-b border-slate-100">
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('stories'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors cursor-pointer ${currentScreen === 'stories' ? 'text-primary bg-rose-50/60' : 'text-slate-400'}`}
                  title="Home"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'stories' ? 'fill-icon' : ''}`}>home</span>
                </button>
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('discover'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors cursor-pointer ${currentScreen === 'discover' ? 'text-primary bg-rose-50/60' : 'text-slate-400'}`}
                  title="Discover"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'discover' ? 'fill-icon' : ''}`}>explore</span>
                </button>
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('chat'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors relative cursor-pointer ${currentScreen === 'chat' ? 'text-primary bg-rose-50/60' : 'text-slate-400'}`}
                  title="Chat"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'chat' ? 'fill-icon' : ''}`}>chat_bubble</span>
                  {recentChats.some(c => c.unreadCount > 0) && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-primary rounded-full animate-pulse"></span>
                  )}
                </button>
                <button
                  onClick={() => { setSelectedChatPartner(null); navigateTo('notifications'); }}
                  className={`p-2 rounded-full hover:bg-slate-100 transition-colors relative cursor-pointer ${currentScreen === 'notifications' ? 'text-primary bg-rose-50/60' : 'text-slate-400'}`}
                  title="Alerts"
                >
                  <span className={`material-symbols-outlined text-[20px] ${currentScreen === 'notifications' ? 'fill-icon' : ''}`}>notifications</span>
                  {notifications.some(n => !n.read) && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-primary rounded-full"></span>
                  )}
                </button>
                <button
                  onClick={handleLogout}
                  className="p-2 rounded-full hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
                  title="Log Out"
                >
                  <span className="material-symbols-outlined text-[20px]">logout</span>
                </button>
              </div>
            )}

            {/* Sidebar Search bar (Desktop only) */}
            {windowWidth >= 1024 && (
              <div className="p-3 bg-white border-b border-slate-100">
                <div className="flex gap-2 bg-slate-50 border border-slate-200/50 rounded-xl px-3 py-1.5 items-center">
                  <span className="material-symbols-outlined text-slate-400 text-[18px]">search</span>
                  <input
                    type="text"
                    value={chatSearchQuery}
                    onChange={(e) => setChatSearchQuery(e.target.value)}
                    placeholder="Search members..."
                    className="bg-transparent border-none w-full text-xs text-[#111d23] placeholder:text-slate-400 outline-none"
                  />
                </div>
              </div>
            )}

            {/* Chats list / Contacts list */}
            <div className="flex-1 overflow-y-auto scrollbar-hide py-2 px-1 space-y-1.5">
              {windowWidth >= 1024 && chatSearchQuery.trim() !== '' && (
                <div className="px-2 pb-2 border-b border-slate-50">
                  <h4 className="text-[9px] font-extrabold text-primary uppercase tracking-wider text-left mb-1.5 px-2">Search Results</h4>
                  <div className="flex flex-col gap-1 max-h-[180px] overflow-y-auto scrollbar-hide">
                    {(() => {
                      const query = chatSearchQuery.toLowerCase();
                      const localMatched = AVAILABLE_PEOPLE.filter(
                        (p) =>
                          p.name.toLowerCase().includes(query) ||
                          (p.username && p.username.toLowerCase().includes(query)) ||
                          p.id.toLowerCase().includes(query)
                      );
                      const dbMapped: ChatPartner[] = dbSearchResults
                        .filter((dbUser) => dbUser.uid !== auth.currentUser?.uid)
                        .map((dbUser) => ({
                          id: dbUser.uid,
                          name: dbUser.name || 'Anonymous',
                          username: dbUser.username || dbUser.uid,
                          photo: dbUser.photo || IMAGES.primaryOnboardingPic,
                          bio: dbUser.bio || 'Aura Member',
                          age: dbUser.age || 21,
                        }));
                      const seenIds = new Set<string>();
                      const matched: ChatPartner[] = [];
                      for (const item of [...dbMapped, ...localMatched]) {
                        if (!seenIds.has(item.id)) {
                          seenIds.add(item.id);
                          matched.push(item);
                        }
                      }
                      if (matched.length > 0) {
                        return matched.map((person) => (
                          <button
                            key={person.id}
                            type="button"
                            onClick={() => {
                              setSelectedChatPartner(person);
                              setChatSearchQuery('');
                              navigateTo('chat');
                            }}
                            className="flex items-center gap-2 p-1.5 rounded-xl hover:bg-slate-50 border border-slate-100 text-left w-full transition-all cursor-pointer"
                          >
                            <ProfileImage src={person.photo} name={person.name} className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                            <div className="flex flex-col min-w-0">
                              <span className="text-[11px] font-bold text-slate-800 truncate leading-tight">{person.name}</span>
                              <span className="text-[8px] text-primary truncate">@{person.username || person.id}</span>
                            </div>
                          </button>
                        ));
                      } else {
                        return <p className="text-[9px] text-slate-400 text-center py-1">No results</p>;
                      }
                    })()}
                  </div>
                </div>
              )}

              {/* Active list */}
              {recentChats.length === 0 ? (
                <div className="py-12 text-center text-slate-400 px-4">
                  <span className="material-symbols-outlined text-2xl opacity-35">forum</span>
                  {windowWidth >= 1024 && (
                    <p className="text-[10px] mt-2 leading-relaxed">No active chats.<br/>Use Discover or Search above to follow someone!</p>
                  )}
                </div>
              ) : (
                recentChats.map((chat) => {
                  const isActive = selectedChatPartner && selectedChatPartner.id === chat.uid;
                  const hasUnread = chat.unreadCount > 0;
                  return (
                    <button
                      key={chat.uid}
                      onClick={() => {
                        setSelectedChatPartner({
                          id: chat.uid,
                          name: chat.name,
                          photo: chat.photo,
                          username: chat.username,
                        });
                        navigateTo('chat');
                      }}
                      className={`w-full flex items-center gap-3 p-2 rounded-xl transition-all text-left cursor-pointer ${
                        isActive 
                          ? 'bg-rose-50/50 border border-rose-100/30' 
                          : 'hover:bg-slate-50 border border-transparent'
                      }`}
                    >
                      <div className="relative shrink-0 mx-auto sm:mx-0">
                        <div className={`w-10 h-10 rounded-full p-[1.5px] ${chat.hasStory ? 'bg-gradient-to-tr from-primary to-purple-500' : 'bg-slate-100 border border-slate-200'}`}>
                          <ProfileImage src={chat.photo} name={chat.name} className="w-full h-full rounded-full object-cover border-2 border-white" />
                        </div>
                        <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full"></div>
                      </div>

                      {windowWidth >= 1024 && (
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-baseline mb-0.5">
                            <span className="text-[11px] font-bold text-slate-800 truncate">{chat.name}</span>
                            <span className="text-[8px] text-slate-400 shrink-0">{chat.lastMessageTime || 'Ready'}</span>
                          </div>
                          <p className={`text-[10px] truncate ${hasUnread ? 'text-slate-800 font-bold' : 'text-slate-400'}`}>
                            {chat.lastMessageText || 'Tap to send messages!'}
                          </p>
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Center Right Active Panel */}
          <div className="flex-1 h-full relative overflow-hidden flex flex-col bg-[#fdf8f9]">
            {/* If Chat view but no partner is selected: WhatsApp Web greeting placeholder screen */}
            {currentScreen === 'chat' && !selectedChatPartner ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[#faf6f7] h-full">
                <div className="w-24 h-24 rounded-full bg-primary/5 flex items-center justify-center text-primary mb-6 animate-float">
                  <img src={IMAGES.auraLogo} alt="Aura Logo" className="w-14 h-14 object-contain brightness-95" />
                </div>
                <h2 className="text-base font-extrabold text-[#111d23] uppercase tracking-widest mb-2">Aura for Web</h2>
                <p className="text-xs text-slate-500 max-w-[320px] leading-relaxed">
                  Select a mutual match from your sidebar list to start private direct messaging. Send photos, links, and text instantly with safe screenshot notifications!
                </p>
              </div>
            ) : (
              /* Content Window Container with generous negative space & responsive scaling */
              <div className="flex-1 flex flex-col overflow-y-auto scrollbar-hide relative h-full w-full">
                <div className="flex-1 relative w-full h-full">
                  {children}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    // Mobile layout
    return (
      <div className="relative w-full max-w-[540px] h-full bg-[#fdf8f9] overflow-hidden flex flex-col shadow-2xl">
        <div className="flex-1 flex flex-col overflow-y-auto scrollbar-hide relative pb-10">
          {children}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#111d23] text-[#111d23] font-sans selection:bg-[#ffb2be] selection:text-[#400014] flex flex-col items-center justify-center w-full h-screen overflow-hidden">
      {renderAppLayout(
        <>
        {/* Push Notification Banner Prompt */}
        {auth.currentUser && notificationPermissionState === 'default' && (
          <div className="bg-[#b80049] text-white py-2.5 px-4 flex items-center justify-between gap-3 text-xs shadow-md shrink-0 relative z-[2000] animate-fade-in w-full">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="material-symbols-outlined text-rose-200 text-[18px] animate-pulse">notifications_active</span>
              <p className="font-semibold text-[10.5px] truncate">Aura wants to send you real-time matches & messages. Enable push notifications?</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={requestBrowserNotificationPermission}
                className="bg-white text-[#b80049] hover:bg-rose-50 font-extrabold text-[10px] uppercase px-3 py-1.5 rounded-lg active:scale-95 transition-all cursor-pointer shadow-sm"
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => setNotificationPermissionState('dismissed')}
                className="text-white/80 hover:text-white p-1 rounded-full hover:bg-white/10 active:scale-95 transition-all cursor-pointer"
                title="Dismiss"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
          </div>
        )}

        {/* Hidden File Input for Real Photo Upload */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          style={{ display: 'none' }}
        />
          {/* ==================== 1. SCREEN: WELCOME / SPLASH ==================== */}
          {currentScreen === 'welcome' && (
            <div className="absolute inset-0 flex flex-col justify-between py-12 px-6 z-10 animate-fade-in">
              {/* Background Hero Image */}
              <div className="absolute inset-0 z-0">
                <div
                  className="absolute inset-0 bg-cover bg-center transition-transform duration-[15s] scale-105"
                  style={{ backgroundImage: `url(${IMAGES.coupleBackground})` }}
                ></div>
                <div className="absolute inset-0 bg-vignette"></div>
              </div>

              {/* Logo Section */}
              <div className="relative z-10 flex flex-col items-center mt-12 animate-float">
                <div className="w-28 h-28 rounded-3xl overflow-hidden shadow-2xl bg-white/90 p-4 flex items-center justify-center">
                  <img alt="Aura Logo" className="w-full h-full object-contain" src={IMAGES.auraLogo} />
                </div>
                <h1 className="mt-4 font-title-md text-[32px] tracking-[0.25em] text-white font-bold drop-shadow-md">
                  AURA
                </h1>
                <p className="text-[11px] tracking-[0.4em] text-white/70 uppercase">Find Your Spark</p>
              </div>

              {/* Action Controls */}
              <div className="relative z-10 w-full flex flex-col items-center space-y-5">
                <div className="text-center space-y-2 mb-2">
                  <h2 className="font-title-md text-2xl text-white drop-shadow-lg leading-tight font-extrabold">
                    Find your spark.
                  </h2>
                  <p className="text-xs text-white/90 max-w-[280px] mx-auto drop-shadow-sm leading-relaxed">
                    The premium dating experience for those seeking meaningful connections.
                  </p>
                </div>

                <button
                  onClick={() => navigateTo('signin')}
                  className="w-full bg-primary hover:bg-[#e2165f] text-white font-title-md py-4.5 rounded-2xl transition-all duration-300 transform btn-glow active:scale-95 font-semibold text-center"
                  id="welcome-get-started-btn"
                >
                  Get Started
                </button>

                <button
                  onClick={() => navigateTo('signin')}
                  className="text-xs text-white font-medium hover:text-[#ffb2be] transition-colors duration-200 underline underline-offset-4 decoration-white/40"
                  id="welcome-login-btn"
                >
                  Log In
                </button>

                <p className="text-[10px] text-white/60 text-center px-4 leading-normal">
                  By joining, you agree to our Terms of Service and Privacy Policy.
                </p>
              </div>
            </div>
          )}

          {/* ==================== 2. SCREEN: SIGN IN ==================== */}
          {currentScreen === 'signin' && (
            <div className="absolute inset-0 flex flex-col justify-between py-12 px-6 z-10 animate-fade-in bg-cover bg-center overflow-y-auto scrollbar-hide" style={{ backgroundImage: `url(${IMAGES.coupleCafeBg})` }}>
              <div className="absolute inset-0 bg-vignette opacity-80 z-0"></div>

              {/* Top/Logo */}
              <header className="relative z-10 w-full flex flex-col items-center pt-4">
                <div className="w-16 h-16 mb-2 drop-shadow-xl bg-white/20 backdrop-blur rounded-2xl p-2 flex items-center justify-center">
                  <img alt="Aura Logo" className="w-full h-full object-contain" src={IMAGES.auraLogo} />
                </div>
                <h1 className="font-title-md text-2xl tracking-[0.2em] text-primary font-extrabold uppercase">
                  Aura
                </h1>
              </header>

              {/* Message Section */}
              <section className="relative z-10 w-full text-center my-4">
                <h2 className="font-title-md text-2xl text-white font-bold mb-2">
                  Find meaningful connections
                </h2>
                <p className="text-sm text-white/80 max-w-[280px] mx-auto leading-relaxed">
                  {emailMode === 'login' ? 'Log in with your email' : emailMode === 'signup' ? 'Create a new account' : 'Join a community of individuals seeking depth and genuine sparks.'}
                </p>
              </section>

              {/* Actions Section */}
              <section className="relative z-10 w-full space-y-4">
                <div className="glass-container rounded-3xl p-5 flex flex-col gap-3">
                  
                  {/* Error Notification */}
                  {authError && (
                    <div className="flex flex-col gap-2">
                      <div className="bg-red-500/20 text-red-100 text-xs px-3 py-2.5 rounded-xl text-center border border-red-500/30">
                        {authError}
                      </div>
                    </div>
                  )}

                   {emailMode === 'options' && (
                    <>
                      <button
                        onClick={handleGoogleSignIn}
                        disabled={authLoading}
                        className="w-full h-13 bg-white hover:bg-slate-50 text-[#111d23] font-medium rounded-xl flex items-center justify-center gap-3 transition-all shadow-sm border border-outline/10 active:scale-98 text-sm disabled:opacity-50 cursor-pointer"
                        id="signin-google-btn"
                      >
                        <svg className="w-5 h-5" viewBox="0 0 24 24">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"></path>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"></path>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"></path>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"></path>
                        </svg>
                        <span>Continue with Google</span>
                      </button>

                      <button
                        onClick={() => {
                          setAuthError('');
                          setEmailMode('login');
                        }}
                        className="w-full h-13 bg-primary hover:bg-[#e2165f] text-white font-medium rounded-xl flex items-center justify-center gap-3 transition-all glow-button active:scale-98 text-sm cursor-pointer"
                        id="signin-email-btn"
                      >
                        <span className="material-symbols-outlined text-[20px]">mail</span>
                        <span>Continue with Email</span>
                      </button>

                      <div className="flex flex-col gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => {
                            setUserProfile({
                              ...INITIAL_USER,
                              username: 'guest',
                              name: 'Guest Explorer',
                              following: [],
                              followers: []
                            });
                            setUserRegistered(false);
                            setIsGuest(true);
                            setAuthError('');
                            navigateTo('discover');
                          }}
                          className="w-full h-11 bg-white/10 hover:bg-white/20 text-white font-medium rounded-xl flex items-center justify-center gap-2 transition-all active:scale-98 text-xs cursor-pointer border border-white/20"
                          id="signin-guest-btn"
                        >
                          <span className="material-symbols-outlined text-sm">visibility</span>
                          <span>Explore as Guest</span>
                        </button>
                      </div>
                    </>
                  )}

                  {(emailMode === 'login' || emailMode === 'signup') && (
                    <form onSubmit={emailMode === 'login' ? handleEmailSignIn : handleEmailSignUp} className="flex flex-col gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-white tracking-wider">EMAIL ADDRESS</label>
                        <input
                          type="email"
                          required
                          placeholder="your.email@example.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="w-full h-11 bg-white/15 border border-white/20 rounded-xl px-4 text-xs text-white placeholder-white/40 focus:bg-white/20 focus:border-white/50 outline-none transition-all"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-white tracking-wider">PASSWORD</label>
                        <input
                          type="password"
                          required
                          placeholder="••••••••"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="w-full h-11 bg-white/15 border border-white/20 rounded-xl px-4 text-xs text-white placeholder-white/40 focus:bg-white/20 focus:border-white/50 outline-none transition-all"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={authLoading}
                        className="w-full h-12 mt-2 bg-primary hover:bg-[#e2165f] text-white font-medium rounded-xl flex items-center justify-center gap-2 transition-all glow-button active:scale-98 text-xs font-bold disabled:opacity-50 cursor-pointer"
                      >
                        {authLoading ? (
                          <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                        ) : emailMode === 'login' ? (
                          'LOG IN'
                        ) : (
                          'SIGN UP'
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setEmailMode('options');
                          setEmail('');
                          setPassword('');
                          setAuthError('');
                        }}
                        className="w-full py-1 text-xs text-white/60 hover:text-white transition-colors text-center cursor-pointer"
                      >
                        Back
                      </button>

                      <div className="text-center text-xs text-white/80 mt-2">
                        {emailMode === 'login' ? (
                          <span>
                            Don't have an account?{' '}
                            <button
                              type="button"
                              onClick={() => {
                                setAuthError('');
                                setEmailMode('signup');
                              }}
                              className="text-primary font-bold hover:underline"
                            >
                              Sign Up
                            </button>
                          </span>
                        ) : (
                          <span>
                            Already have an account?{' '}
                            <button
                              type="button"
                              onClick={() => {
                                setAuthError('');
                                setEmailMode('login');
                              }}
                              className="text-primary font-bold hover:underline"
                            >
                              Log In
                            </button>
                          </span>
                        )}
                      </div>
                    </form>
                  )}
                </div>

                <footer className="w-full flex flex-col items-center gap-2 pt-2">
                  <p className="text-[10px] text-white/60 text-center max-w-[280px]">
                    By signing up, you agree to our <a className="underline hover:text-primary decoration-white/30" href="#">Terms</a> and <a className="underline hover:text-primary decoration-white/30" href="#">Privacy Policy</a>
                  </p>
                </footer>
              </section>
            </div>
          )}

          {/* ==================== 3. SCREEN: ONBOARDING BASICS ==================== */}
          {currentScreen === 'onboarding_basics' && (
            <div className="px-6 py-4 space-y-6">
              {/* Header */}
              <div className="flex justify-between items-center h-10">
                <button onClick={() => navigateTo('signin')} className="text-slate-600 hover:text-primary active:scale-95">
                  <span className="material-symbols-outlined">close</span>
                </button>
                <h1 className="font-title-md text-xl text-primary tracking-widest font-extrabold">AURA</h1>
                <div className="w-6"></div>
              </div>

              {/* Progress Bar */}
              <div>
                <div className="flex justify-between items-center mb-1.5 text-xs font-semibold text-primary">
                  <span>Step 1 of 3</span>
                  <span>33%</span>
                </div>
                <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full progress-glow" style={{ width: '33%' }}></div>
                </div>
              </div>

              {/* Hero Text */}
              <div>
                <h2 className="font-title-md text-2xl text-on-surface font-extrabold mb-1">The basics</h2>
                <p className="text-xs text-secondary">Tell us a bit about yourself to help us find your perfect match.</p>
              </div>

              {/* Form fields */}
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold tracking-widest text-[#5b3f43] block">FIRST NAME</label>
                  <input
                    type="text"
                    value={onboardingName}
                    onChange={(e) => setOnboardingName(e.target.value)}
                    placeholder="Enter your name"
                    className="w-full h-12 bg-white border border-slate-200 rounded-xl px-4 text-sm focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold tracking-widest text-[#5b3f43] block">USERNAME</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-semibold">@</span>
                    <input
                      type="text"
                      value={onboardingUsername}
                      onChange={(e) => setOnboardingUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''))}
                      placeholder="unique_username"
                      className="w-full h-12 bg-white border border-slate-200 rounded-xl pl-8 pr-4 text-xs focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all font-mono text-on-surface"
                    />
                  </div>
                  <p className="text-[9px] text-slate-400">This unique username lets friends find and follow you to chat.</p>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold tracking-widest text-[#5b3f43] block">DATE OF BIRTH</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      maxLength={2}
                      placeholder="DD"
                      value={onboardingDob.dd}
                      onChange={(e) => setOnboardingDob({ ...onboardingDob, dd: e.target.value })}
                      className="w-16 h-12 bg-white border border-slate-200 rounded-xl text-center text-sm focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all"
                    />
                    <input
                      type="text"
                      maxLength={2}
                      placeholder="MM"
                      value={onboardingDob.mm}
                      onChange={(e) => setOnboardingDob({ ...onboardingDob, mm: e.target.value })}
                      className="w-16 h-12 bg-white border border-slate-200 rounded-xl text-center text-sm focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all"
                    />
                    <input
                      type="text"
                      maxLength={4}
                      placeholder="YYYY"
                      value={onboardingDob.yyyy}
                      onChange={(e) => setOnboardingDob({ ...onboardingDob, yyyy: e.target.value })}
                      className="flex-1 h-12 bg-white border border-slate-200 rounded-xl text-center text-sm focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all"
                    />
                  </div>
                  <p className="text-[10px] text-secondary/70">Your age will be public.</p>
                </div>

                {/* Gender */}
                <div className="space-y-2 pt-2">
                  <label className="text-[10px] font-bold tracking-widest text-[#5b3f43] block">GENDER</label>
                  <div className="grid grid-cols-2 gap-2">
                    {['Woman', 'Man'].map((gender) => (
                      <button
                        key={gender}
                        onClick={() => setOnboardingGender(gender)}
                        className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-xs ${
                          onboardingGender === gender
                            ? 'bg-primary text-white border-primary shadow-md'
                            : 'bg-white text-on-surface border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <span>{gender}</span>
                        <span className={`material-symbols-outlined text-[16px] ${onboardingGender === gender ? 'text-white' : 'text-slate-400'}`}>
                          {gender === 'Woman' ? 'female' : 'male'}
                        </span>
                      </button>
                    ))}
                    <button
                      onClick={() => setOnboardingGender('Non-binary')}
                      className={`col-span-2 flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-xs ${
                        onboardingGender === 'Non-binary'
                          ? 'bg-primary text-white border-primary shadow-md'
                          : 'bg-white text-on-surface border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <span>Non-binary</span>
                      <span className={`material-symbols-outlined text-[16px] ${onboardingGender === 'Non-binary' ? 'text-white' : 'text-slate-400'}`}>
                        transgender
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Quote Decorative Element */}
              <div className="relative overflow-hidden rounded-2xl h-24 bg-[#f4dce4]/40 flex items-center justify-center p-4 text-center mt-6">
                <p className="font-title-md text-xs text-[#524249] leading-tight italic">
                  "Love is not something you find. Love is something that finds you."
                </p>
              </div>

              {/* Bottom Navigation */}
              <nav className="fixed bottom-0 left-0 w-full bg-white/95 backdrop-blur-md flex justify-between items-center px-6 py-4 h-20 shadow-[0_-4px_20px_rgba(38,50,56,0.04)] z-50">
                <button
                  onClick={() => navigateTo('signin')}
                  className="flex flex-col items-center justify-center text-slate-500 hover:text-primary active:scale-95"
                >
                  <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                  <span className="text-[10px] font-bold">Back</span>
                </button>
                <button
                  onClick={() => {
                    const year = parseInt(onboardingDob.yyyy);
                    if (!onboardingDob.yyyy || isNaN(year) || year < 1900 || year > new Date().getFullYear()) {
                      showToast("Please enter a valid birth year.", "error");
                      return;
                    }
                    const age = new Date().getFullYear() - year;
                    if (age < 18) {
                      showToast("You must be 18 years or older to register on Aura.", "error");
                      return;
                    }
                    // Update user profile properties nicely
                    setUserProfile((prev) => ({
                      ...prev,
                      name: onboardingName || prev.name,
                      username: onboardingUsername.toLowerCase().trim() || onboardingName.toLowerCase().replace(/\s+/g, '_') || prev.username,
                      gender: onboardingGender || prev.gender,
                      dob: onboardingDob.yyyy ? onboardingDob : prev.dob,
                      age: age,
                    }));
                    navigateTo('onboarding_interests');
                  }}
                  disabled={!onboardingName || !onboardingUsername || !onboardingGender || !onboardingDob.yyyy}
                  className="bg-primary text-white rounded-xl px-6 py-2.5 shadow-lg flex items-center gap-1 hover:brightness-110 active:scale-98 transition-all disabled:opacity-50 disabled:pointer-events-none text-xs font-semibold"
                >
                  <span>Continue</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </nav>
            </div>
          )}

          {/* ==================== 4. SCREEN: ONBOARDING INTERESTS ==================== */}
          {currentScreen === 'onboarding_interests' && (
            <div className="px-6 py-4 space-y-6">
              {/* Header */}
              <div className="flex justify-between items-center h-10">
                <button onClick={() => navigateTo('onboarding_basics')} className="text-slate-600 hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
                <h1 className="font-title-md text-xl text-primary tracking-widest font-extrabold">AURA</h1>
                <div className="w-6"></div>
              </div>

              {/* Progress */}
              <div>
                <div className="flex justify-between items-center text-xs font-semibold text-primary mb-1">
                  <span>Step 2 of 3</span>
                  <span>66%</span>
                </div>
                <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: '66%' }}></div>
                </div>
              </div>

              {/* Hero */}
              <div>
                <h2 className="font-title-md text-2xl text-on-surface font-extrabold mb-1">What sparks your aura?</h2>
                <p className="text-xs text-secondary">
                  Select at least 5 interests to help us find meaningful connections. We use these to curate your daily matches.
                </p>
              </div>

              {/* Interests Grid */}
              <div className="flex flex-wrap gap-2 pt-2">
                {INTERESTS_OPTIONS.map((interest) => {
                  const isSelected = onboardingInterests.includes(interest.name);
                  return (
                    <button
                      key={interest.name}
                      onClick={() => handleToggleInterest(interest.name)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-all ${
                        isSelected
                          ? 'bg-primary text-white border-primary shadow-md'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <span className={`material-symbols-outlined text-[14px] ${isSelected ? 'text-white' : 'text-primary'}`}>
                        {interest.icon}
                      </span>
                      <span>{interest.name}</span>
                    </button>
                  );
                })}
              </div>

              {/* Curation Logic Card */}
              <div className="rounded-2xl p-4 bg-secondary-container/40 flex flex-col items-center text-center mt-4">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                  <span className="material-symbols-outlined text-primary text-lg">auto_awesome</span>
                </div>
                <h3 className="font-title-md text-[13px] text-on-secondary-container font-bold mb-0.5">Curation Logic</h3>
                <p className="text-[10px] text-secondary-container-variant max-w-[240px] leading-relaxed">
                  Our algorithm pairs you with individuals who share your aesthetic and intellectual pursuits.
                </p>
              </div>

              {/* Navigation */}
              <nav className="fixed bottom-0 left-0 w-full bg-white/95 backdrop-blur-md flex justify-between items-center px-6 py-4 h-20 shadow-[0_-4px_20px_rgba(38,50,56,0.04)] z-50">
                <button
                  onClick={() => navigateTo('onboarding_basics')}
                  className="flex flex-col items-center justify-center text-slate-500 hover:text-primary"
                >
                  <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                  <span className="text-[10px] font-bold">Back</span>
                </button>
                <button
                  onClick={() => {
                    setUserProfile((prev) => ({
                      ...prev,
                      interests: onboardingInterests,
                    }));
                    navigateTo('onboarding_photos');
                  }}
                  disabled={onboardingInterests.length < 3}
                  className="bg-primary text-white rounded-xl px-6 py-2.5 shadow-lg flex items-center gap-1 hover:brightness-110 active:scale-98 disabled:opacity-50 disabled:pointer-events-none text-xs font-semibold"
                >
                  <span>Continue</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </nav>
            </div>
          )}

          {/* ==================== 5. SCREEN: ONBOARDING PHOTOS ==================== */}
          {currentScreen === 'onboarding_photos' && (
            <div className="px-6 py-4 space-y-6">
              {/* Header */}
              <div className="flex justify-between items-center h-10">
                <button onClick={() => navigateTo('onboarding_interests')} className="text-slate-600 hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
                <h1 className="font-title-md text-xl text-primary tracking-widest font-extrabold">AURA</h1>
                <div className="w-6"></div>
              </div>

              {/* Progress */}
              <div>
                <div className="h-1 bg-slate-200 rounded-full overflow-hidden mb-1">
                  <div className="bg-primary h-full w-full"></div>
                </div>
              </div>

              {/* Headline */}
              <div>
                <h2 className="font-title-md text-xl text-on-surface font-extrabold mb-1">Show your best self</h2>
                <p className="text-xs text-secondary leading-relaxed">
                  Upload at least 2 photos to find more meaningful connections. Your primary photo is your first impression.
                </p>
              </div>

              {/* Photo Bento Grid */}
              <div className="grid grid-cols-6 grid-rows-3 gap-3 h-[380px] pt-1">
                {/* Large primary slot */}
                <div className="col-span-4 row-span-2 relative overflow-hidden rounded-2xl bg-slate-100 group shadow-sm">
                  <div className="absolute inset-0 z-10 bg-gradient-to-t from-slate-900/40 to-transparent pointer-events-none"></div>
                  <img
                    alt="Primary user"
                    className="w-full h-full object-cover"
                    src={profilePicUrls[0] || IMAGES.primaryOnboardingPic}
                  />
                  <div className="absolute bottom-3 left-3 z-20">
                    <span className="bg-primary text-white text-[9px] uppercase tracking-widest font-bold px-2 py-0.5 rounded-full">
                      Primary
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setPhotoSlotToEdit(0);
                      fileInputRef.current?.click();
                    }}
                    className="absolute top-3 right-3 z-20 w-8 h-8 bg-white/90 backdrop-blur rounded-full flex items-center justify-center text-primary shadow-sm hover:scale-105 active:scale-90 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                </div>

                {/* Placeholders */}
                {[1, 2, 3, 4, 5].map((idx) => (
                  <div
                    key={idx}
                    onClick={() => {
                      setPhotoSlotToEdit(idx);
                      fileInputRef.current?.click();
                    }}
                    className="col-span-2 row-span-1 rounded-2xl bg-slate-50 border-2 border-dashed border-[#e4bdc2] flex flex-col items-center justify-center cursor-pointer hover:bg-slate-100/50 hover:border-primary/50 transition-colors overflow-hidden relative"
                  >
                    {profilePicUrls[idx] ? (
                      <>
                        <img src={profilePicUrls[idx]} className="w-full h-full object-cover rounded-2xl" alt="upload preview" />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const updated = [...profilePicUrls];
                            updated.splice(idx, 1);
                            setProfilePicUrls(updated);
                          }}
                          className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white text-[10px] hover:bg-black cursor-pointer"
                        >
                          ×
                        </button>
                      </>
                    ) : (
                      <span className="material-symbols-outlined text-primary text-[20px]">add_a_photo</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Pro Tip section */}
              <div className="p-3 bg-[#f4dce4] rounded-xl flex items-start gap-3">
                <span className="material-symbols-outlined text-primary text-[18px] mt-0.5">lightbulb</span>
                <div>
                  <h4 className="text-xs text-primary font-bold">Pro Tip</h4>
                  <p className="text-[10px] text-[#524249] leading-relaxed">
                    Profiles with clear, smiling outdoor photos get 3x more interest on Aura. Avoid group photos for your primary slot.
                  </p>
                </div>
              </div>

              {/* Navigation */}
              <nav className="fixed bottom-0 left-0 w-full bg-white/95 backdrop-blur-md flex justify-between items-center px-6 py-4 h-20 shadow-[0_-4px_20px_rgba(38,50,56,0.04)] z-50">
                <button
                  onClick={() => navigateTo('onboarding_interests')}
                  className="flex flex-col items-center justify-center text-slate-500 hover:text-primary"
                >
                  <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                  <span className="text-[10px] font-bold">Back</span>
                </button>
                <button
                  onClick={() => {
                    const finalProfile = {
                      ...userProfile,
                      photos: profilePicUrls,
                    };
                    setUserProfile(finalProfile);
                    saveProfileToFirestore(finalProfile);
                    navigateTo('location_access');
                  }}
                  className="bg-primary text-white rounded-xl px-6 py-2.5 shadow-lg flex items-center gap-1 hover:brightness-110 active:scale-98 text-xs font-semibold cursor-pointer"
                >
                  <span>Continue</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </nav>
            </div>
          )}

          {/* ==================== 6. SCREEN: LOCATION ACCESS ==================== */}
          {currentScreen === 'location_access' && (
            <div className="absolute inset-0 flex flex-col justify-between py-12 px-6 bg-white animate-fade-in">
              {/* Header */}
              <div className="flex justify-between items-center w-full">
                <button onClick={() => navigateTo('discover')} className="text-primary active:scale-95">
                  <span className="material-symbols-outlined">close</span>
                </button>
                <h1 className="font-title-md text-xl text-primary font-bold tracking-widest uppercase">AURA</h1>
                <div className="w-6"></div>
              </div>

              {/* Illustration Map background */}
              <div className="relative w-full h-56 flex items-center justify-center overflow-hidden rounded-3xl mt-2 bg-cover bg-center" style={{ backgroundImage: `url(${IMAGES.mapBackground})` }}>
                <div className="absolute inset-0 bg-gradient-to-t from-white via-white/10 to-transparent"></div>
                <div className="relative z-10 flex flex-col items-center">
                  <div className="w-20 h-20 bg-primary/20 rounded-full flex items-center justify-center shadow-2xl animate-float">
                    <span className="material-symbols-outlined text-4xl text-primary fill-icon">favorite</span>
                  </div>
                  <div className="absolute w-28 h-28 bg-primary/10 rounded-full blur-2xl animate-pulse"></div>
                </div>
              </div>

              {/* Text */}
              <div className="text-center space-y-3 mt-4">
                <h2 className="font-title-md text-2xl text-on-background font-extrabold">Find matches near you</h2>
                <p className="text-xs text-slate-500 max-w-[280px] mx-auto leading-relaxed">
                  Discover meaningful connections just around the corner. Enabling location helps us curate the most relevant profiles in your immediate vicinity.
                </p>
              </div>

              {/* Info Card */}
              <div className="w-full p-4 bg-[#e9f6fd] rounded-2xl shadow-sm flex items-start gap-3">
                <div className="bg-primary/10 p-1.5 rounded-lg">
                  <span className="material-symbols-outlined text-primary text-sm">explore</span>
                </div>
                <div className="flex flex-col text-left space-y-0.5">
                  <p className="text-xs text-[#111d23] font-bold">Smart Proximity</p>
                  <p className="text-[10px] text-slate-500">We prioritize quality over distance, but staying local makes meeting up effortless.</p>
                </div>
              </div>

              {/* Privacy block */}
              <div className="flex items-center justify-center gap-1.5 opacity-70 text-center">
                <span className="material-symbols-outlined text-xs">lock</span>
                <span className="text-[9px] text-slate-500">Privacy Note: Your exact location is never shared with anyone.</span>
              </div>

              {/* Action trigger */}
              <div className="w-full flex flex-col gap-2">
                <button
                  onClick={() => {
                    const finalProfile = { ...userProfile, location: 'San Francisco, CA' };
                    setUserProfile(finalProfile);
                    saveProfileToFirestore(finalProfile);
                    navigateTo('discover');
                  }}
                  className="w-full bg-primary text-white font-title-md text-sm py-3.5 rounded-2xl glow-shadow hover:brightness-110 active:scale-[0.98] transition-all font-semibold cursor-pointer"
                >
                  Enable Location
                </button>
                <button
                  onClick={() => {
                    saveProfileToFirestore();
                    navigateTo('discover');
                  }}
                  className="w-full text-slate-500 hover:text-primary font-medium text-xs py-2 cursor-pointer"
                >
                  Maybe Later
                </button>
              </div>
            </div>
          )}

          {/* ==================== 7. SCREEN: DISCOVER (SWIPE) ==================== */}
          {currentScreen === 'discover' && (() => {
            if (discoverLoading && discoverPeople.length === 0) {
              return (
                <div className="px-6 pt-4 flex flex-col h-full animate-pulse space-y-6">
                  <div className="w-full aspect-[3/4] bg-slate-200 rounded-3xl relative flex items-end p-5">
                    <div className="w-full space-y-3">
                      <div className="flex justify-between items-end">
                        <div className="space-y-2">
                          <div className="h-6 w-32 bg-slate-300 rounded-lg"></div>
                          <div className="h-3.5 w-20 bg-slate-300 rounded-md"></div>
                        </div>
                        <div className="h-5 w-16 bg-slate-300 rounded-full"></div>
                      </div>
                      <div className="h-3 w-full bg-slate-300 rounded-md"></div>
                      <div className="h-3 w-2/3 bg-slate-300 rounded-md"></div>
                    </div>
                  </div>
                  <div className="flex items-center justify-center gap-6 w-full pt-2">
                    <div className="w-12 h-12 rounded-full bg-slate-200"></div>
                    <div className="w-16 h-16 rounded-full bg-slate-200"></div>
                    <div className="w-12 h-12 rounded-full bg-slate-200"></div>
                  </div>
                </div>
              );
            }

            if (discoverPeople.length === 0 || activeDiscoverIndex >= discoverPeople.length) {
              return (
                <div className="px-6 pt-4 flex flex-col items-center justify-center text-center space-y-5 h-[calc(100vh-140px)] animate-fade-in">
                  <div className="w-20 h-20 bg-rose-50 rounded-full flex items-center justify-center text-primary relative">
                    <span className="material-symbols-outlined text-4xl fill-icon">volunteer_activism</span>
                    <span className="absolute -bottom-1 -right-1 bg-amber-400 text-[10px] px-1.5 py-0.5 rounded-full font-bold shadow-md">Completed</span>
                  </div>
                  <div className="space-y-1.5 max-w-[280px]">
                    <h3 className="font-title-md text-base font-extrabold text-[#111d23]">You've seen everyone!</h3>
                    <p className="text-[10.5px] text-slate-400 leading-relaxed">
                      {discoverLoading ? "Curating more matches matching your profile..." : "There are no more new users nearby matching your preferences. Try updating your profile or checking back later!"}
                    </p>
                  </div>
                  {!discoverLoading && (
                    <button
                      onClick={() => {
                        fetchDbMatches(false);
                      }}
                      className="px-5 py-2.5 bg-primary text-white text-xs font-bold rounded-xl active:scale-95 shadow-md hover:brightness-110 transition-all flex items-center gap-2 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-sm">refresh</span>
                      <span>Refresh Matches</span>
                    </button>
                  )}
                  {discoverLoading && (
                    <div className="flex items-center gap-2 text-primary font-bold text-xs animate-pulse">
                      <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                      <span>Loading more matches...</span>
                    </div>
                  )}
                </div>
              );
            }

            const activePerson = discoverPeople[activeDiscoverIndex % discoverPeople.length] || AVAILABLE_PEOPLE[0];
            return (
              <div className="px-6 pt-4 flex flex-col animate-fade-in h-full relative">
                {/* Discover Header */}
                <div className="flex items-center justify-between mb-3 shrink-0">
                  <div className="text-left">
                    <span className="text-[10px] text-primary uppercase font-extrabold tracking-wider leading-none">Suggested for you</span>
                    <h2 className="text-lg font-extrabold text-[#111d23] leading-none mt-1">Discover Sparks</h2>
                  </div>
                  <button
                    onClick={() => setShowDiscoverFilterModal(true)}
                    className="p-2 rounded-xl bg-white border border-slate-200/60 shadow-sm text-slate-500 hover:text-primary hover:border-primary/40 active:scale-95 transition-all flex items-center justify-center cursor-pointer"
                    title="Filter Preferences"
                  >
                    <span className="material-symbols-outlined text-[20px]">tune</span>
                  </button>
                </div>

                {/* Main Swipe Profile Card */}
                <div
                  onClick={() => {
                    setSelectedDiscoverPerson(activePerson);
                    navigateTo('profile_details');
                  }}
                  className="relative w-full aspect-[3/4] rounded-3xl overflow-hidden shadow-xl group cursor-pointer border border-[#f3e5f5]"
                >
                  <div className="absolute inset-0 bg-slate-100">
                    <ProfileImage src={activePerson.photo} name={activePerson.name} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" alt={`${activePerson.name} profile card`} />
                    <div className="vignette-bottom absolute inset-0"></div>
                  </div>

                  {/* Card profile overlay content */}
                  <div className="absolute bottom-0 left-0 w-full p-5 text-white z-10 space-y-2.5">
                    <div className="flex items-end justify-between">
                      <div>
                        <div className="flex items-center gap-1.5 text-left flex-wrap">
                          <h2 className="font-title-md text-2xl text-white font-extrabold leading-none">{activePerson.name}, {activePerson.age || 25}</h2>
                          {activePerson.isDemo ? (
                            <span className="bg-amber-500/80 text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded-md uppercase tracking-wider leading-none">Demo</span>
                          ) : (
                            <span className="material-symbols-outlined text-[18px] text-white fill-icon">verified</span>
                          )}
                        </div>
                        <p className="text-xs text-white/90 font-medium text-left">@{activePerson.username || activePerson.id}</p>
                      </div>

                      <div className="flex items-center gap-0.5 bg-white/25 backdrop-blur-md px-2.5 py-1 rounded-full text-white text-[10px] font-semibold">
                        <span className="material-symbols-outlined text-[13px]">location_on</span>
                        <span>2 miles</span>
                      </div>
                    </div>

                    {/* Bio Summary */}
                    <p className="text-[11px] text-slate-100/90 font-normal leading-normal text-left line-clamp-2">
                      {activePerson.bio || 'New member of Aura community'}
                    </p>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-center gap-6 mt-4 w-full">
                  <button
                    onClick={() => handleSwipe('dislike')}
                    className="w-12 h-12 rounded-full border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:text-primary hover:bg-slate-50 transition-all duration-200 active:scale-90 shadow-sm cursor-pointer"
                    title="Dislike"
                  >
                    <span className="material-symbols-outlined text-[24px]">close</span>
                  </button>

                  <button
                    onClick={() => handleSwipe('like')}
                    className="w-16 h-16 rounded-full bg-primary flex items-center justify-center text-white action-glow-heart hover:scale-105 active:scale-90 transition-all duration-300 cursor-pointer"
                    title="Like"
                  >
                    <span className="material-symbols-outlined text-[32px] fill-icon">favorite</span>
                  </button>

                  <button
                    onClick={() => handleSwipe('superlike')}
                    className="w-12 h-12 rounded-full border border-yellow-300 bg-white flex items-center justify-center text-yellow-600 hover:bg-yellow-50 transition-all duration-200 active:scale-90 shadow-sm cursor-pointer"
                    title="Super Like"
                  >
                    <span className="material-symbols-outlined text-[24px] fill-icon">star</span>
                  </button>
                </div>

                {/* Discover Filters Modal Overlay */}
                {showDiscoverFilterModal && (
                  <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm z-[1000] flex items-center justify-center p-6 animate-fade-in text-left">
                    <div className="w-full max-w-[340px] bg-white rounded-3xl border border-slate-100 shadow-2xl p-6 space-y-6 animate-scale-up">
                      <div className="flex justify-between items-center pb-2 border-b border-slate-50">
                        <div className="text-left">
                          <h3 className="font-title-md text-sm font-extrabold text-slate-800">Filter Preferences</h3>
                          <p className="text-[10px] text-slate-400">Refine your match discoveries</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowDiscoverFilterModal(false)}
                          className="w-8 h-8 rounded-full hover:bg-slate-50 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-lg">close</span>
                        </button>
                      </div>

                      {/* Gender Preference */}
                      <div className="space-y-2 text-left">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Interested In</label>
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            { label: 'Everyone', value: 'all' },
                            { label: 'Men', value: 'Man' },
                            { label: 'Women', value: 'Woman' },
                            { label: 'Non-Binary', value: 'Non-Binary' }
                          ].map((g) => (
                            <button
                              key={g.value}
                              type="button"
                              onClick={() => setDiscoverFilterGender(g.value)}
                              className={`py-2 px-3 rounded-xl text-[11px] font-bold border transition-all cursor-pointer ${
                                discoverFilterGender === g.value
                                  ? 'bg-primary border-primary text-white shadow-sm shadow-primary/20'
                                  : 'bg-white border-slate-200/60 text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {g.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Age Range */}
                      <div className="space-y-3.5 text-left">
                        <div className="flex justify-between items-baseline">
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Age Range</label>
                          <span className="text-xs font-extrabold text-primary font-mono">{discoverFilterMinAge} - {discoverFilterMaxAge}</span>
                        </div>
                        <div className="space-y-4 pt-1">
                          {/* Min Age Slider */}
                          <div className="space-y-1">
                            <div className="flex justify-between text-[9px] text-slate-400 font-medium">
                              <span>Min Age</span>
                              <span>{discoverFilterMinAge} yrs</span>
                            </div>
                            <input
                              type="range"
                              min="18"
                              max="100"
                              value={discoverFilterMinAge}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setDiscoverFilterMinAge(val);
                                if (val > discoverFilterMaxAge) {
                                  setDiscoverFilterMaxAge(val);
                                }
                              }}
                              className="w-full accent-primary h-1 bg-slate-100 rounded-lg appearance-none cursor-pointer"
                            />
                          </div>

                          {/* Max Age Slider */}
                          <div className="space-y-1">
                            <div className="flex justify-between text-[9px] text-slate-400 font-medium">
                              <span>Max Age</span>
                              <span>{discoverFilterMaxAge} yrs</span>
                            </div>
                            <input
                              type="range"
                              min="18"
                              max="100"
                              value={discoverFilterMaxAge}
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setDiscoverFilterMaxAge(val);
                                if (val < discoverFilterMinAge) {
                                  setDiscoverFilterMinAge(val);
                                }
                              }}
                              className="w-full accent-primary h-1 bg-slate-100 rounded-lg appearance-none cursor-pointer"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Apply Button */}
                      <button
                        type="button"
                        onClick={() => {
                          fetchDbMatches(false);
                          setShowDiscoverFilterModal(false);
                        }}
                        className="w-full bg-primary hover:bg-primary-hover text-white text-xs font-bold py-3.5 rounded-2xl shadow-lg hover:shadow-xl transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-98"
                      >
                        <span className="material-symbols-outlined text-sm">filter_alt</span>
                        Apply Filters
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ==================== 8. SCREEN: PROFILE DETAILS ==================== */}
          {currentScreen === 'profile_details' && (() => {
            if (publicProfileError) {
              return (
                <div className="absolute inset-0 bg-white flex flex-col items-center justify-center p-6 text-center z-[50]">
                  <div className="w-20 h-20 bg-rose-50 rounded-full flex items-center justify-center text-rose-500 mb-6 animate-pulse">
                    <span className="material-symbols-outlined text-[40px]">person_off</span>
                  </div>
                  <h2 className="text-2xl font-title font-extrabold text-slate-800 mb-2">Profile Not Found</h2>
                  <p className="text-slate-500 text-sm max-w-sm mb-8 leading-relaxed">
                    The public profile you are looking for does not exist, has been deactivated, or the username is invalid.
                  </p>
                  <button
                    onClick={() => {
                      setIsPublicView(false);
                      setPublicProfileError(false);
                      navigateTo(auth.currentUser ? 'discover' : 'welcome');
                    }}
                    className="px-6 py-3 bg-primary text-white text-xs font-bold uppercase tracking-wider rounded-xl shadow-md hover:bg-opacity-90 transition-all cursor-pointer active:scale-95"
                  >
                    Go Back
                  </button>
                </div>
              );
            }
            const targetUser = selectedDiscoverPerson || discoverPeople[activeDiscoverIndex % discoverPeople.length] || AVAILABLE_PEOPLE[0];
            return (
              <div className="absolute inset-0 bg-white flex flex-col animate-fade-in overflow-hidden z-[50]">
                {/* Navigation Back */}
                <header className="absolute top-0 left-0 right-0 z-[100] flex items-center justify-between px-4 h-16 bg-white/95 backdrop-blur-md shadow-sm border-b border-slate-100">
                  <button onClick={() => {
                    if (isPublicView) {
                      setIsPublicView(false);
                      navigateTo(auth.currentUser ? 'discover' : 'welcome');
                    } else {
                      navigateTo('discover');
                    }
                  }} className="text-primary active:scale-90 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[20px]">arrow_back</span>
                    <span className="text-xs font-bold uppercase tracking-wider">Back</span>
                  </button>
                  <h1 className="font-title-md text-sm text-[#111d23] font-bold truncate max-w-[150px]">
                    {targetUser.name}'s Profile
                  </h1>
                  <div className="flex items-center gap-2">
                    {/* Share Button */}
                    <button
                      onClick={() => {
                        const profileUrl = `${window.location.origin}/u/${targetUser.username || targetUser.id}`;
                        if (navigator.share) {
                          navigator.share({
                            title: `${targetUser.name} (@${targetUser.username || targetUser.id}) | Aura`,
                            text: `Check out ${targetUser.name}'s profile on Aura!`,
                            url: profileUrl,
                          }).catch(() => {});
                        } else {
                          navigator.clipboard?.writeText(profileUrl);
                          setProfileShareOpen(true);
                          setTimeout(() => setProfileShareOpen(false), 3000);
                        }
                      }}
                      className="text-slate-600 hover:text-primary active:scale-90 p-1 flex items-center justify-center rounded-full hover:bg-slate-50"
                      title="Share Profile"
                    >
                      <span className="material-symbols-outlined text-[20px]">share</span>
                    </button>
                    {/* Options Button */}
                    <button
                      onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                      className="text-slate-600 hover:text-primary active:scale-90 p-1 flex items-center justify-center rounded-full hover:bg-slate-50"
                      title="More Options"
                    >
                      <span className="material-symbols-outlined text-[20px]">more_vert</span>
                    </button>
                  </div>
                </header>

                {/* Profile Share Success Toast */}
                {profileShareOpen && (
                  <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[200] bg-slate-900 text-white px-4 py-2 rounded-full text-[11px] font-bold shadow-lg flex items-center gap-1.5 animate-fade-in">
                    <span className="material-symbols-outlined text-xs text-green-400 fill-icon">check_circle</span>
                    <span>Profile link copied to clipboard!</span>
                  </div>
                )}

                {/* Options Dropdown Menu */}
                {profileMenuOpen && (
                  <div className="absolute right-4 top-16 z-[110] bg-white rounded-2xl shadow-xl border border-slate-100 p-2 w-48 animate-fade-in text-left">
                    <button
                      onClick={() => {
                        showToast(`You reported @${targetUser.username || targetUser.id}. We will review their profile.`, "info");
                        setProfileMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-rose-600 hover:bg-rose-50 rounded-xl transition-all font-semibold flex items-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">report</span>
                      <span>Report @{targetUser.username || targetUser.id}</span>
                    </button>
                    <button
                      onClick={() => {
                        showToast(`You blocked @${targetUser.username || targetUser.id}.`, "info");
                        setProfileMenuOpen(false);
                        navigateTo('discover');
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 rounded-xl transition-all font-semibold flex items-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">block</span>
                      <span>Block User</span>
                    </button>
                    <button
                      onClick={() => {
                        setUserSparks(5);
                        localStorage.setItem('aura_user_sparks', '5');
                        showToast("Sparks successfully reset to 5!", "success");
                        setProfileMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-primary hover:bg-purple-50 rounded-xl transition-all font-semibold flex items-center gap-2"
                    >
                      <span className="material-symbols-outlined text-sm">refresh</span>
                      <span>Reset Sparks (5)</span>
                    </button>
                  </div>
                )}

                {/* Scrollable body content container */}
                <div className="flex-1 overflow-y-auto pb-24 text-left">
                  {/* Main Profile Details Content */}
                  <div className="space-y-4">
                  {/* Complete Photo Gallery (Tinder Style) */}
                  {(() => {
                    const photos = targetUser.photos || [targetUser.photo || IMAGES.coupleBackground];
                    return (
                      <div className="relative w-full aspect-[4/5] overflow-hidden mt-16 shadow-inner bg-slate-900 group">
                        {/* Photos list rendered */}
                        <img
                          src={photos[activePhotoIndex % photos.length] || IMAGES.coupleBackground}
                          className="w-full h-full object-cover select-none transition-all duration-300 cursor-pointer"
                          alt={`${targetUser.name} portrait`}
                          onClick={(e) => {
                            // Check where the click happened to navigate or zoom
                            const rect = e.currentTarget.getBoundingClientRect();
                            const clickX = e.clientX - rect.left;
                            const width = rect.width;
                            if (clickX < width * 0.35) {
                              // Tap left: previous
                              setActivePhotoIndex(prev => (prev - 1 + photos.length) % photos.length);
                            } else if (clickX > width * 0.65) {
                              // Tap right: next
                              setActivePhotoIndex(prev => (prev + 1) % photos.length);
                            } else {
                              // Center: zoom
                              setFullScreenImage(photos[activePhotoIndex % photos.length]);
                            }
                          }}
                        />

                        {/* Tinder-style Indicator Bars */}
                        {photos.length > 1 && (
                          <div className="absolute top-3 inset-x-4 flex gap-1.5 z-30">
                            {photos.map((_, pIdx) => (
                              <div key={pIdx} className="flex-1 h-1 bg-white/30 rounded-full overflow-hidden">
                                <div 
                                  className={`h-full bg-white transition-all duration-300 ${pIdx === (activePhotoIndex % photos.length) ? 'w-full' : 'w-0'}`}
                                />
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Gradient shading */}
                        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/80 via-black/20 to-transparent pointer-events-none"></div>

                        {/* Navigation visual guides (shown on hover or as overlays) */}
                        {photos.length > 1 && (
                          <>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setActivePhotoIndex(prev => (prev - 1 + photos.length) % photos.length);
                              }}
                              className="absolute left-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity active:scale-90"
                            >
                              <span className="material-symbols-outlined text-sm">chevron_left</span>
                            </button>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setActivePhotoIndex(prev => (prev + 1) % photos.length);
                              }}
                              className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity active:scale-90"
                            >
                              <span className="material-symbols-outlined text-sm">chevron_right</span>
                            </button>
                          </>
                        )}

                        {/* Zoom icon helper */}
                        <button
                          onClick={() => setFullScreenImage(photos[activePhotoIndex % photos.length])}
                          className="absolute right-4 bottom-4 w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 text-white backdrop-blur-md flex items-center justify-center active:scale-90 transition-all z-20 shadow-lg"
                          title="Open full-screen viewer"
                        >
                          <span className="material-symbols-outlined text-lg">zoom_in</span>
                        </button>
                      </div>
                    );
                  })()}

                  {/* Bio and Info Sections */}
                  <div className="px-6 py-2 space-y-5">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <h2 className="font-title-md text-2xl text-on-surface font-extrabold leading-none">{targetUser.name}, {targetUser.age || 25}</h2>
                          <span className="material-symbols-outlined text-[20px] text-primary fill-icon">verified</span>
                        </div>
                        <p className="text-xs text-slate-500 font-semibold">@{targetUser.username || targetUser.id}</p>
                      </div>
                      <div className="flex items-center text-slate-500 gap-0.5 text-xs font-bold">
                        <span className="material-symbols-outlined text-[16px] text-primary">location_on</span>
                        <span>{targetUser.location || '2 miles away'}</span>
                      </div>
                    </div>

                    {/* Followers and Following Counts Panel */}
                    <div className="flex gap-4 py-3.5 border-y border-slate-100/70 my-2">
                      <button
                        onClick={() => {
                          if (isGuest) {
                            setGuestWarningModal('like');
                            return;
                          }
                          openFollowList('followers', targetUser.id, targetUser.name);
                        }}
                        className="flex-1 text-center hover:bg-slate-50 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        <span className="block text-base font-extrabold text-slate-800 font-title-md">
                          {targetProfileStats ? targetProfileStats.followersCount : (targetUser.followers?.length || 0)}
                        </span>
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Followers</span>
                      </button>
                      <div className="w-[1px] bg-slate-100 self-stretch"></div>
                      <button
                        onClick={() => {
                          if (isGuest) {
                            setGuestWarningModal('like');
                            return;
                          }
                          openFollowList('following', targetUser.id, targetUser.name);
                        }}
                        className="flex-1 text-center hover:bg-slate-50 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        <span className="block text-base font-extrabold text-slate-800 font-title-md">
                          {targetProfileStats ? targetProfileStats.followingCount : (targetUser.following?.length || 0)}
                        </span>
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Following</span>
                      </button>
                    </div>

                    <p className="text-xs text-slate-600 leading-relaxed font-normal">
                      {targetUser.bio || 'Passionate about connecting with mindful people, sharing daily vibes, and discovering the extra-ordinary.'}
                    </p>

                    {/* About Me card */}
                    <div className="space-y-1.5">
                      <h3 className="font-title-md text-sm text-on-surface font-bold">About Me</h3>
                      <div className="bg-[#fce4ec]/30 p-4 rounded-2xl shadow-sm border border-[#e4bdc2]/20">
                        <p className="text-xs text-slate-700 leading-relaxed font-normal">
                          {targetUser.about || `I believe in staying authentic, sharing sparks, and creating deep connections. If you value deep conversations and a positive aura, let's explore together!`}
                        </p>
                      </div>
                    </div>

                    {/* Active Stories Section */}
                    {(() => {
                      const targetStories = dbStories.filter(s => s.userUid === targetUser.id);
                      if (targetStories.length === 0) return null;
                      return (
                        <div className="space-y-2 pt-1">
                          <h3 className="font-title-md text-sm text-on-surface font-bold flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[18px] text-primary">auto_awesome_motion</span>
                            <span>Active Stories</span>
                          </h3>
                          <div className="flex gap-2 overflow-x-auto scrollbar-hide py-1">
                            {targetStories.map((story, idx) => (
                              <div
                                key={story.id}
                                onClick={() => {
                                  setStoryViewerList(targetStories);
                                  setActiveStoryIndex(idx);
                                }}
                                className="relative w-20 h-32 rounded-xl overflow-hidden shrink-0 cursor-pointer border border-slate-100 shadow-xs hover:scale-105 transition-all"
                              >
                                <img src={story.photo} className="w-full h-full object-cover" alt="Story thumbnail" />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>
                                <span className="absolute bottom-1 left-1.5 text-[9px] text-white font-bold max-w-[70px] truncate">
                                  Story #{idx + 1}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Interests */}
                    <div className="space-y-1.5">
                      <h3 className="font-title-md text-sm text-on-surface font-bold">Interests</h3>
                      <div className="flex flex-wrap gap-2">
                        {(targetUser.interests || ['Art', 'Travel', 'Hiking', 'Music']).map((tag: string) => (
                          <span key={tag} className="px-3 py-1.5 rounded-full bg-[#F3E5F5] text-[#263238] font-bold text-[10px] tracking-wide uppercase">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Prompts Section */}
                    <div className="space-y-3 pt-2">
                      <h3 className="font-title-md text-sm text-on-surface font-bold">Prompts</h3>
                      <div className="p-4 rounded-2xl border border-slate-100 bg-white/70 shadow-sm space-y-1.5">
                        <span className="text-primary font-bold text-[9px] tracking-wider block uppercase">My perfect Sunday...</span>
                        <p className="font-title-md text-sm text-on-surface leading-tight font-extrabold">
                          Starts with fresh espresso, ends with custom vibes and zero stress.
                        </p>
                      </div>
                      <div className="p-4 rounded-2xl border border-slate-100 bg-white/70 shadow-sm space-y-1.5">
                        <span className="text-primary font-bold text-[9px] tracking-wider block uppercase">We'll get along if...</span>
                        <p className="font-title-md text-sm text-on-surface leading-tight font-extrabold">
                          You prefer handwritten thoughts, authentic vibes, and direct chats.
                        </p>
                      </div>
                    </div>
                  </div>

                  {isPublicView ? (
                    <div className="py-5 w-full bg-gradient-to-r from-[#b80049]/5 via-[#fce4ec]/15 to-[#b80049]/5 sticky bottom-0 z-40 border-t border-[#e4bdc2]/35 px-6 flex flex-col items-center space-y-3 shadow-2xl backdrop-blur-md">
                      <p className="text-xs text-[#524249] font-bold text-center">
                        ✨ Like what you see? Connect with <span className="text-primary font-extrabold">{targetUser.name}</span> on Aura!
                      </p>
                      <button
                        onClick={() => {
                          setIsPublicView(false);
                          navigateTo('welcome');
                        }}
                        className="w-full max-w-[280px] h-12 bg-primary text-white font-title-md text-xs uppercase tracking-wider font-extrabold rounded-xl shadow-lg hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-sm">person_add</span>
                        <span>Join Aura Now</span>
                      </button>
                    </div>
                  ) : (
                    /* Floating Action Buttons */
                    <div className="flex gap-3 py-4 w-full bg-white/95 sticky bottom-10 z-40 border-t border-slate-100 px-6">
                      {(() => {
                        const followingList = userProfile.following || [];
                        const isFollowing = followingList.includes(targetUser.id);
                        return (
                          <button
                            onClick={() => {
                              if (isGuest) {
                                setGuestWarningModal('like');
                                return;
                              }
                              toggleFollowUser(targetUser.id);
                              if (!isFollowing) {
                                navigateTo('spark_match');
                              }
                            }}
                            className={`flex-1 h-12 rounded-xl text-xs font-extrabold uppercase tracking-widest transition-all flex items-center justify-center gap-2 cursor-pointer border ${
                              isFollowing
                                ? 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
                                : 'bg-primary border-primary text-white hover:brightness-110 shadow-md glow-shadow'
                            }`}
                          >
                            <span className="material-symbols-outlined text-sm font-bold">
                              {isFollowing ? 'check' : 'favorite'}
                            </span>
                            <span>{isFollowing ? 'Following' : 'Follow'}</span>
                          </button>
                        );
                      })()}

                      <button
                        onClick={() => {
                          if (isGuest) {
                            setGuestWarningModal('message');
                            return;
                          }
                          setSelectedChatPartner(targetUser);
                          navigateTo('chat');
                        }}
                        className="flex-1 h-12 bg-white border border-slate-200 rounded-xl text-xs font-extrabold uppercase tracking-widest text-slate-700 hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm active:scale-95"
                      >
                        <span className="material-symbols-outlined text-sm font-bold">chat</span>
                        <span>Message</span>
                      </button>

                      <button
                        onClick={() => {
                          if (isPublicView) {
                            setIsPublicView(false);
                            navigateTo(auth.currentUser ? 'discover' : 'welcome');
                          } else {
                            navigateTo('discover');
                          }
                        }}
                        className="w-12 h-12 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500 shrink-0 transition-all active:scale-95 cursor-pointer"
                        title="Close Profile"
                      >
                        <span className="material-symbols-outlined text-[20px]">close</span>
                      </button>
                    </div>
                  )}
                </div>
                </div> {/* End of scrollable container */}
              </div>
            );
          })()}

          {/* ==================== 9. SCREEN: SPARK MATCH ==================== */}
          {currentScreen === 'spark_match' && (() => {
            const activePerson = discoverPeople[activeDiscoverIndex % discoverPeople.length] || AVAILABLE_PEOPLE[0];
            return (
              <div className="absolute inset-0 flex flex-col justify-between py-12 px-6 z-20 animate-fade-in bg-gradient-to-tr from-[#fce4ec] via-[#f4faff] to-[#ffd9de]">
                {/* Gentle floating sparkles background */}
                <div className="absolute inset-0 opacity-40 overflow-hidden pointer-events-none z-0">
                  <div className="absolute top-[10%] left-[20%] w-2 h-2 bg-primary rounded-full animate-float" style={{ animationDelay: '0s' }}></div>
                  <div className="absolute top-[40%] right-[15%] w-3 h-3 bg-[#ffb2be] rounded-full animate-float" style={{ animationDelay: '2s' }}></div>
                  <div className="absolute bottom-[30%] left-[10%] w-2 h-2 bg-primary-container rounded-full animate-float" style={{ animationDelay: '1s' }}></div>
                </div>

                {/* Reward Celebration Icon */}
                <div className="relative z-10 flex flex-col items-center mt-6 animate-float">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary-container text-white shadow-xl">
                    <span className="material-symbols-outlined text-[28px] fill-icon">auto_awesome</span>
                  </div>
                </div>

                {/* Overlapping Profile Photos */}
                <div className="relative z-10 w-full flex justify-center items-center h-48 my-2">
                  {/* Glow rings */}
                  <div className="absolute w-36 h-36 rounded-full border border-primary/20 animate-slow-pulse"></div>
                  <div className="absolute w-48 h-48 rounded-full border border-slate-500/10 animate-slow-pulse" style={{ animationDelay: '-2s' }}></div>

                  <div className="relative flex items-center">
                    {/* Left profile (user) */}
                    <div className="relative z-20 -mr-4 transform hover:scale-105 transition-all">
                      <div className="w-28 h-28 rounded-full border-4 border-white shadow-2xl overflow-hidden bg-slate-200">
                        <ProfileImage src={userProfile.photo} name={userProfile.name} className="w-full h-full object-cover" alt="User matched portrait" />
                      </div>
                      <div className="absolute bottom-0 right-0 bg-white rounded-full p-1.5 shadow-md">
                        <span className="material-symbols-outlined text-primary text-xs fill-icon">favorite</span>
                      </div>
                    </div>

                    {/* Right profile (activePerson) */}
                    <div className="relative z-10 transform hover:scale-105 transition-all">
                      <div className="w-28 h-28 rounded-full border-4 border-white shadow-2xl overflow-hidden bg-slate-200">
                        <ProfileImage src={activePerson.photo} name={activePerson.name} className="w-full h-full object-cover" alt={`${activePerson.name} portrait`} />
                      </div>
                      <div className="absolute bottom-0 left-0 bg-white rounded-full p-1.5 shadow-md">
                        <span className="material-symbols-outlined text-primary text-xs fill-icon">favorite</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Typography */}
                <div className="relative z-10 text-center space-y-1">
                  <h1 className="font-title-md text-[40px] text-primary tracking-tight font-extrabold">
                    It's a Spark!
                  </h1>
                  <p className="text-sm text-slate-600 max-w-[240px] mx-auto leading-normal">
                    You and {activePerson.name} have liked each other.
                  </p>
                </div>

                {/* Call to Actions */}
                <div className="relative z-10 w-full space-y-3 flex flex-col items-center">
                  <button
                    onClick={() => {
                      setSelectedChatPartner(activePerson);
                      navigateTo('chat');
                    }}
                    className="group relative w-full h-12 bg-primary text-white font-title-md text-sm rounded-xl shadow-lg hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 font-bold cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">send</span>
                    <span>Send a Message</span>
                  </button>

                  <button
                    onClick={() => navigateTo('discover')}
                    className="w-full h-12 bg-white/70 border border-slate-300 text-on-surface font-title-md text-sm rounded-xl hover:bg-slate-50 transition-all active:scale-[0.98] font-bold cursor-pointer"
                  >
                    Keep Exploring
                  </button>
                </div>

                {/* Footer discrete branding */}
                <footer className="relative z-10 pt-4 text-center">
                  <span className="text-[10px] text-slate-400 tracking-[0.25em] uppercase font-bold">Aura Premium</span>
                </footer>
              </div>
            );
          })()}

          {/* ==================== 10. SCREEN: CHAT INBOX & ACTIVE CHAT ==================== */}
          {currentScreen === 'chat' && !selectedChatPartner && (
            <div className="absolute inset-0 flex flex-col animate-fade-in bg-[#f4faff]">

              {/* Scrollable Container */}
              <div className="flex-1 overflow-y-auto px-6 pt-6 pb-4 space-y-4 scrollbar-hide">
                <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-3">
                  <div className="space-y-1">
                    <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Search Members by @Username or Name</h2>
                    <p className="text-[10px] text-slate-400">Mutual follow is required to unlock direct messaging.</p>
                  </div>
                  <div className="flex gap-2 bg-slate-50 border border-slate-200/50 rounded-xl px-3 py-2">
                    <span className="material-symbols-outlined text-slate-400 text-lg">search</span>
                    <input
                      type="text"
                      value={chatSearchQuery}
                      onChange={(e) => setChatSearchQuery(e.target.value)}
                      placeholder="Type username (e.g., elena, sarah, leo) or name..."
                      className="bg-transparent border-none w-full text-xs text-on-surface placeholder:text-slate-400 outline-none font-mono"
                    />
                  </div>

                  {/* Search Results */}
                  {chatSearchQuery.trim() !== '' && (
                    <div className="pt-2 border-t border-slate-100 flex flex-col gap-2.5 max-h-[320px] overflow-y-auto scrollbar-hide">
                      {(() => {
                        const query = chatSearchQuery.toLowerCase();
                        
                        // 1. Local Matches
                        const localMatched = AVAILABLE_PEOPLE.filter(
                          (p) =>
                            p.name.toLowerCase().includes(query) ||
                            (p.username && p.username.toLowerCase().includes(query)) ||
                            p.id.toLowerCase().includes(query)
                        );

                        // 2. Live DB Matches
                        const dbMapped: ChatPartner[] = dbSearchResults
                          .filter((dbUser) => dbUser.uid !== auth.currentUser?.uid)
                          .map((dbUser) => ({
                            id: dbUser.uid,
                            name: dbUser.name || 'Anonymous',
                            username: dbUser.username || dbUser.uid,
                            photo: dbUser.photo || IMAGES.primaryOnboardingPic,
                            bio: dbUser.bio || 'Aura Member',
                            age: dbUser.age || 21,
                          }));

                        // 3. De-duplicate (DB matching has priority)
                        const seenIds = new Set<string>();
                        const matched: ChatPartner[] = [];

                        for (const item of [...dbMapped, ...localMatched]) {
                          if (!seenIds.has(item.id)) {
                            seenIds.add(item.id);
                            matched.push(item);
                          }
                        }

                        if (matched.length > 0) {
                          return matched.map((person) => {
                            const followingList = userProfile.following || [];
                            const isFollowing = followingList.includes(person.id);
                            const isFollowedBack = !!mockFollowBacks[person.id];
                            const isMutual = isFollowing && isFollowedBack;
                            const userStoryIndex = dbStories.findIndex((s) => s.userUid === person.id);
                            const hasStory = userStoryIndex !== -1;

                            return (
                              <div
                                key={person.id}
                                className="p-3 rounded-2xl bg-slate-50/60 border border-slate-100 flex flex-col gap-2 transition-all text-left"
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2.5">
                                    {hasStory ? (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setStoryViewerList(dbStories);
                                          setActiveStoryIndex(userStoryIndex);
                                        }}
                                        className="sunset-gradient-ring p-[2px] rounded-full active:scale-95 transition-transform flex-shrink-0"
                                        title="Click to view story!"
                                      >
                                        <div className="w-9 h-9 rounded-full border-2 border-white overflow-hidden">
                                          <ProfileImage src={person.photo} name={person.name} className="w-full h-full object-cover" />
                                        </div>
                                      </button>
                                    ) : (
                                      <ProfileImage src={person.photo} name={person.name} className="w-10 h-10 rounded-full object-cover border border-slate-200 shadow-sm flex-shrink-0" />
                                    )}
                                    <div className="flex flex-col">
                                      <div className="flex items-center gap-1 flex-wrap">
                                        <span className="text-xs font-bold text-[#111d23]">{person.name}</span>
                                        {person.isDemo && (
                                          <span className="bg-amber-500/10 text-amber-600 text-[8px] font-extrabold px-1 rounded uppercase tracking-wider">Demo</span>
                                        )}
                                        {hasStory && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setStoryViewerList(dbStories);
                                              setActiveStoryIndex(userStoryIndex);
                                            }}
                                            className="bg-gradient-to-r from-pink-500 to-rose-500 text-white text-[8px] font-extrabold px-1.5 py-0.5 rounded-full uppercase tracking-wider animate-pulse flex items-center gap-0.5 cursor-pointer"
                                          >
                                            <span className="material-symbols-outlined text-[8px]">play_circle</span>
                                            Story
                                          </button>
                                        )}
                                      </div>
                                      <span className="text-[10px] text-primary font-mono font-bold">@{person.username || person.id}</span>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-1.5">
                                    {/* Follow/Unfollow Button */}
                                    <button
                                      type="button"
                                      onClick={() => toggleFollowUser(person.id)}
                                      className={`px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-wider transition-all active:scale-95 cursor-pointer ${
                                        isFollowing
                                          ? 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                          : 'bg-primary text-white hover:brightness-110 shadow-sm'
                                      }`}
                                    >
                                      {isFollowing ? '✓ Following' : 'Follow'}
                                    </button>

                                    {/* Message / Lock Chat Action */}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedChatPartner(person);
                                        setChatSearchQuery('');
                                      }}
                                      className={`p-2 rounded-full transition-all active:scale-90 cursor-pointer ${
                                        isMutual
                                          ? 'bg-green-100 text-green-700 hover:bg-green-200'
                                          : 'bg-rose-50 text-rose-500 hover:bg-rose-100'
                                      }`}
                                      title={isMutual ? 'Chat unlocked!' : 'Chat locked. Requires mutual follow.'}
                                    >
                                      <span className="material-symbols-outlined text-[16px] fill-icon">
                                        {isMutual ? 'chat' : 'lock'}
                                      </span>
                                    </button>
                                  </div>
                                </div>

                                {/* Friendship Status Details */}
                                <div className="bg-white/80 rounded-xl p-2 border border-slate-100 flex items-center justify-between text-[9px]">
                                  <div className="flex flex-col gap-0.5 text-left text-slate-500 font-medium">
                                    <span className="flex items-center gap-1">
                                      <span className={`w-1.5 h-1.5 rounded-full ${isFollowing ? 'bg-green-500' : 'bg-slate-300'}`}></span>
                                      {isFollowing ? 'You follow them' : 'You do not follow them'}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <span className={`w-1.5 h-1.5 rounded-full ${isFollowedBack ? 'bg-green-500' : 'bg-slate-300'}`}></span>
                                      {isFollowedBack ? 'They follow you back' : 'They do not follow you yet'}
                                    </span>
                                  </div>

                                  {!isFollowedBack && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setMockFollowBacks(prev => ({ ...prev, [person.id]: true }));
                                      }}
                                      className="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 rounded-lg font-bold transition-colors border border-amber-500/20 cursor-pointer"
                                    >
                                      ⚡ Force Follow-Back
                                    </button>
                                  )}

                                  {isMutual && (
                                    <span className="font-extrabold text-green-600 tracking-wider uppercase bg-green-50 px-2 py-0.5 rounded border border-green-200">
                                      👥 Mutual Match
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          });
                        } else {
                          // Dynamic partner creation for custom usernames
                          const cleanUserQuery = chatSearchQuery.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
                          return (
                            <div className="p-3 rounded-2xl bg-primary/5 border border-primary/10 space-y-2 text-left">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                                    <span className="material-symbols-outlined">person_add</span>
                                  </div>
                                  <div className="flex flex-col text-left">
                                    <span className="text-xs font-bold text-on-surface font-title-md">Custom User</span>
                                    <span className="text-[10px] text-primary font-mono font-bold">@{cleanUserQuery}</span>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => {
                                    const customPartner: ChatPartner = {
                                      id: cleanUserQuery,
                                      username: cleanUserQuery,
                                      name: chatSearchQuery.charAt(0).toUpperCase() + chatSearchQuery.slice(1),
                                      photo: IMAGES.coupleBackground,
                                      bio: 'Custom chat spark',
                                      age: 25,
                                    };
                                    setSelectedChatPartner(customPartner);
                                    setChatSearchQuery('');
                                  }}
                                  className="px-3 py-1.5 rounded-full bg-primary text-white text-[9px] font-bold uppercase tracking-wider active:scale-95 transition-all shadow-sm cursor-pointer"
                                >
                                  Create & Chat
                                </button>
                              </div>
                              <p className="text-[9px] text-slate-500">Tap to start a conversation with a member using username @{cleanUserQuery}.</p>
                            </div>
                          );
                        }
                      })()}
                    </div>
                  )}
                </div>

                {/* New Matches (Horizontal Row) */}
                {(() => {
                  const followingList = userProfile.following || [];
                  const mutualMatches = discoverPeople.filter((p) => {
                    const isFollowing = followingList.includes(p.id);
                    const isFollowedBack = !!mockFollowBacks[p.id];
                    return isFollowing || isFollowedBack;
                  });

                  if (mutualMatches.length === 0) return null;

                  return (
                    <div className="space-y-2 mb-4">
                      <h3 className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider text-left">New Matches</h3>
                      <div className="flex gap-4 overflow-x-auto pb-2 pt-1 scrollbar-hide">
                        {mutualMatches.map((person) => (
                          <button
                            key={person.id}
                            onClick={() => setSelectedChatPartner(person)}
                            className="flex flex-col items-center gap-1.5 focus:outline-none shrink-0 group cursor-pointer"
                          >
                            <div className="relative">
                              <div className="w-14 h-14 rounded-full p-[2px] bg-gradient-to-tr from-primary to-purple-500">
                                <div className="w-full h-full rounded-full border-2 border-white overflow-hidden bg-slate-100">
                                  <ProfileImage src={person.photo} name={person.name} className="w-full h-full object-cover" />
                                </div>
                              </div>
                              <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></div>
                            </div>
                            <span className="text-[10px] font-bold text-slate-700 group-hover:text-primary transition-colors">{person.name}{person.isDemo ? ' (Demo)' : ''}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Conversation List */}
                <div className="space-y-2">
                  <h3 className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider text-left">Active Conversations</h3>
                  {(() => {
                    if (recentChats.length === 0) {
                      return (
                        <div className="flex flex-col items-center justify-center py-10 text-center space-y-3 bg-white rounded-2xl p-6 border border-slate-100 animate-fade-in">
                          <div className="w-16 h-16 rounded-full bg-primary/5 flex items-center justify-center text-primary animate-pulse">
                            <span className="material-symbols-outlined text-3xl">chat_bubble</span>
                          </div>
                          <div className="space-y-1">
                            <h4 className="text-xs font-bold text-[#69575e]">No active chats yet</h4>
                            <p className="text-[10px] text-slate-400 max-w-[200px] leading-relaxed mx-auto">
                              Your inbox is completely clean! Search and follow someone to start a private conversation.
                            </p>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div className="flex flex-col gap-2 animate-fade-in">
                        {recentChats.map((chat) => {
                          const hasStory = chat.hasStory;
                          const hasUnread = chat.unreadCount > 0;

                          return (
                            <div
                              key={chat.uid}
                              onClick={() => {
                                setSelectedChatPartner({
                                  id: chat.uid,
                                  name: chat.name,
                                  photo: chat.photo,
                                  username: chat.username,
                                });
                              }}
                              className={`flex items-center justify-between p-3 rounded-2xl border transition-all cursor-pointer shadow-sm text-left ${
                                hasUnread
                                  ? 'bg-rose-50/20 border-rose-100/50 shadow-md ring-1 ring-rose-500/5'
                                  : 'bg-white border-slate-100 hover:bg-slate-50'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                {/* Avatar with Story Ring */}
                                <div
                                  className="relative cursor-pointer shrink-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const storyIdx = dbStories.findIndex((s) => s.userUid === chat.uid);
                                    if (storyIdx !== -1) {
                                      setStoryViewerList(dbStories);
                                      setActiveStoryIndex(storyIdx);
                                    } else {
                                      setSelectedDiscoverPerson({
                                        id: chat.uid,
                                        name: chat.name,
                                        photo: chat.photo,
                                        username: chat.username,
                                      });
                                      navigateTo('profile_details');
                                    }
                                  }}
                                  title={hasStory ? "View Story" : "View Profile"}
                                >
                                  <div
                                    className={`w-11 h-11 rounded-full p-[2px] ${
                                      hasStory
                                        ? 'bg-gradient-to-tr from-primary to-purple-500'
                                        : 'bg-slate-100 border border-slate-200'
                                    }`}
                                  >
                                    <img
                                      src={chat.photo || IMAGES.coupleBackground}
                                      alt={chat.name}
                                      className="w-full h-full rounded-full object-cover border-2 border-white shadow-xs"
                                    />
                                  </div>
                                  <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full"></div>
                                </div>

                                <div className="flex flex-col">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-xs font-bold text-on-surface">{chat.name}</span>
                                    {chatStreaks[chat.uid] !== undefined && chatStreaks[chat.uid] > 0 && (
                                      <span className="flex items-center text-[9px] font-extrabold text-amber-500 bg-amber-50 px-1.5 py-0.5 rounded-full border border-amber-200/50">
                                        🔥 {chatStreaks[chat.uid]}
                                      </span>
                                    )}
                                  </div>
                                  <span className={`text-[10px] max-w-[180px] truncate ${hasUnread ? 'text-slate-800 font-bold' : 'text-slate-500'}`}>
                                    {chat.lastMessageText || '✨ Tap to type and send messages!'}
                                  </span>
                                </div>
                              </div>

                              <div className="flex flex-col items-end gap-1 text-[9px] text-slate-400 shrink-0">
                                <span className={hasUnread ? 'text-primary font-bold' : ''}>
                                  {chat.lastMessageTime || 'Ready'}
                                </span>
                                {hasUnread ? (
                                  <span className="bg-primary text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full min-w-4 text-center">
                                    {chat.unreadCount}
                                  </span>
                                ) : (
                                  chat.lastMessageText && (
                                    <span className="material-symbols-outlined text-[12px] text-slate-400">check_circle</span>
                                  )
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {currentScreen === 'chat' && selectedChatPartner && (
            <div className="absolute inset-0 flex flex-col justify-between animate-fade-in bg-[#efeae2] pb-[72px]">
              {/* WhatsApp-style Header */}
              <header className="absolute top-0 left-0 right-0 z-50 bg-primary text-white h-16 flex items-center px-3 justify-between shadow-md">
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setSelectedChatPartner(null)} className="text-white active:scale-90 flex items-center justify-center p-1.5 hover:bg-black/10 rounded-full transition-colors">
                    <span className="material-symbols-outlined font-bold text-[22px]">arrow_back</span>
                  </button>
                  {(() => {
                    const partnerStoryIndex = dbStories.findIndex(s => s.userUid === selectedChatPartner.id);
                    const hasStory = partnerStoryIndex !== -1;
                    return (
                      <div className="flex items-center gap-2">
                        {hasStory ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setStoryViewerList(dbStories);
                              setActiveStoryIndex(partnerStoryIndex);
                            }}
                            className="sunset-gradient-ring p-[2px] rounded-full active:scale-95 transition-transform flex-shrink-0"
                            title="View Story"
                          >
                            <div className="w-9 h-9 rounded-full border border-white/45 overflow-hidden bg-slate-100">
                              <ProfileImage src={selectedChatPartner.photo} name={selectedChatPartner.name} className="w-full h-full object-cover" alt="Chat avatar" />
                            </div>
                          </button>
                        ) : (
                          <div
                            onClick={() => {
                              setSelectedDiscoverPerson(selectedChatPartner);
                              navigateTo('profile_details');
                            }}
                            className="w-9 h-9 rounded-full border border-white/20 overflow-hidden bg-slate-100 cursor-pointer shrink-0"
                          >
                            <ProfileImage src={selectedChatPartner.photo} name={selectedChatPartner.name} className="w-full h-full object-cover" alt="Chat avatar" />
                          </div>
                        )}
                        <div
                          className="flex flex-col text-left cursor-pointer"
                          onClick={() => {
                            setSelectedDiscoverPerson(selectedChatPartner);
                            navigateTo('profile_details');
                          }}
                        >
                          <div className="flex items-center gap-1">
                            <span className="text-sm font-bold leading-none tracking-tight truncate max-w-[140px]">{selectedChatPartner.name}</span>
                            {selectedChatPartner.isDemo && (
                              <span className="bg-amber-500 text-white text-[8px] font-extrabold px-1 rounded uppercase tracking-wider leading-none">Demo</span>
                            )}
                          </div>
                          <span className="text-[10px] text-pink-100 mt-0.5 font-medium flex items-center gap-1">
                            <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></span>
                            online
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="flex gap-3 items-center">
                  {chatStreaks[selectedChatPartner.id] !== undefined && chatStreaks[selectedChatPartner.id] > 0 && (
                    <span className="flex items-center text-[10px] font-extrabold text-amber-300 bg-black/20 px-2 py-1 rounded-full border border-amber-400/30">
                      🔥 {chatStreaks[selectedChatPartner.id]}
                    </span>
                  )}
                  <button
                    onClick={() => {
                      setSelectedDiscoverPerson(selectedChatPartner);
                      navigateTo('profile_details');
                    }}
                    className="text-white hover:bg-black/10 p-1.5 rounded-full"
                    title="View Profile Details"
                  >
                    <span className="material-symbols-outlined text-lg font-bold">info</span>
                  </button>
                </div>
              </header>

              {/* Messages Thread Container */}
              <div className="flex-1 overflow-y-auto px-4 pt-20 pb-2 space-y-4 scrollbar-hide flex flex-col bg-[#efeae2]">
                {/* Encryption Notice */}
                <div className="flex justify-center my-1 max-w-[90%] mx-auto">
                  <div className="bg-[#ffeecd] border border-amber-200/40 text-[10px] text-[#554a36] py-1.5 px-3 rounded-lg text-center font-medium shadow-xs flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-xs text-amber-600 fill-icon">lock</span>
                    <span>Messages are end-to-end encrypted and private.</span>
                  </div>
                </div>

                {/* Direct Message / Non-Mutual Follow Banner */}
                {!isMutualFollower(selectedChatPartner.id) && (
                  <div className="bg-[#fff3cd] border border-amber-200 rounded-xl p-3 text-center space-y-2.5 shadow-xs my-1 animate-fade-in text-slate-800">
                    <p className="text-[10px] text-slate-600 leading-relaxed font-semibold">
                      You are not mutually following @{selectedChatPartner.username || selectedChatPartner.id} yet. Instantly match to chat without restrictions!
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        toggleFollowUser(selectedChatPartner.id);
                        setMockFollowBacks((prev) => ({ ...prev, [selectedChatPartner.id]: true }));
                      }}
                      className="px-3.5 py-1 bg-primary text-white text-[10px] font-bold rounded-md hover:brightness-110 active:scale-95 shadow-xs transition-all cursor-pointer inline-flex items-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-xs">favorite</span>
                      <span>Instant Match & Unlock</span>
                    </button>
                  </div>
                )}

                {(() => {
                  const messages = conversations[selectedChatPartner.id] || [];
                  return messages.map((msg, idx) => {
                    const isUser = msg.sender === 'user';
                    
                    // Group/date separator check
                    const showDateLabel = idx === 0 || (() => {
                      const prevMsg = messages[idx - 1];
                      if (!msg.createdAt || !prevMsg.createdAt) return false;
                      const dateCurr = new Date(msg.createdAt).toDateString();
                      const datePrev = new Date(prevMsg.createdAt).toDateString();
                      return dateCurr !== datePrev;
                    })();

                    return (
                      <div key={msg.id} className="flex flex-col space-y-2">
                        {showDateLabel && msg.createdAt && (
                          <div className="flex justify-center my-2 animate-fade-in">
                            <span className="text-[10px] font-bold px-3 py-1 rounded-full bg-slate-200/80 text-slate-600 shadow-xs uppercase tracking-wider">
                              {getMessageDateLabel(msg.createdAt)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex flex-col max-w-[85%] ${isUser ? 'self-end items-end' : 'self-start items-start'}`}
                        >
                          <div
                            className={`px-3 py-2.5 rounded-2xl relative shadow-xs border ${
                              isUser
                                ? 'bg-primary text-white rounded-tr-none border-[#000000]/10'
                                : 'bg-white text-slate-800 rounded-tl-none border-slate-200/50'
                            }`}
                          >
                            {msg.image && (
                              <div className="w-full rounded-lg overflow-hidden mb-1 border border-slate-100 shadow-xs max-w-[280px]">
                                <img src={msg.image} className="w-full max-h-48 object-cover" alt="Attachment" />
                              </div>
                            )}
                            {msg.text && <p className="text-xs leading-normal font-medium pr-10">{msg.text}</p>}
                            
                            <div className={`absolute bottom-1 right-1.5 flex items-center gap-0.5 text-[9px] ${isUser ? 'text-pink-200' : 'text-slate-400'}`}>
                              <span>{msg.time}</span>
                              {isUser && (
                                msg.isRead ? (
                                  <span className="material-symbols-outlined text-[12px] text-[#53bdeb] font-bold" title="Read">done_all</span>
                                ) : (
                                  <span className="material-symbols-outlined text-[12px] text-pink-200/75 font-bold" title="Sent">done</span>
                                )
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}

                {/* Typing Indicator */}
                {isElenaTyping && (
                  <div className="flex items-center gap-1.5 self-start animate-pulse">
                    <div className="bg-white border border-slate-100 px-3.5 py-2 rounded-2xl rounded-tl-none flex gap-1 items-center shadow-xs">
                      <span className="text-[10px] text-slate-500 font-medium">typing</span>
                      <div className="w-1 h-1 bg-primary rounded-full animate-bounce"></div>
                      <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                      <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Modern Fixed Message Composer / Follow Gating */}
              {(() => {
                const isDemo = selectedChatPartner.isDemo;
                const relationSent = activeChatPartnerProfile?.relationSent || 'none';
                const isFollowed = isDemo || relationSent === 'accepted';

                if (!isFollowed) {
                  return (
                    <footer className="bg-slate-50 border-t border-slate-200 px-4 py-4 flex flex-col items-center justify-center gap-3.5 z-40 text-center shadow-inner animate-fade-in">
                      <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                        <span className="material-symbols-outlined text-2xl font-bold">lock</span>
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-xs font-bold text-slate-800">
                          {relationSent === 'pending' ? 'Follow Request Sent' : 'Follow to start Chatting'}
                        </h4>
                        <p className="text-[10px] text-slate-500 max-w-[280px] leading-relaxed mx-auto">
                          {relationSent === 'pending'
                            ? `Your follow request to @${activeChatPartnerProfile?.username || selectedChatPartner.name} is currently pending acceptance.`
                            : `You must follow @${activeChatPartnerProfile?.username || selectedChatPartner.name} first before sending secure end-to-end encrypted direct messages.`}
                        </p>
                      </div>

                      {relationSent !== 'pending' && (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const res = await fetchFromBackend('/api/follows', {
                                method: 'POST',
                                  body: JSON.stringify({ followingUid: selectedChatPartner.id })
                              });
                              if (res.ok) {
                                const data = await res.json();
                                showToast(data.status === 'accepted' ? 'Successfully followed!' : 'Follow request sent!', 'success');
                                // Refresh partner profile state
                                const profileRes = await fetchFromBackend(`/api/users/profile/${selectedChatPartner.id}`);
                                if (profileRes.ok) {
                                  const profileData = await profileRes.json();
                                  setActiveChatPartnerProfile(profileData);
                                }
                                fetchRecentChats();
                              }
                            } catch (e) {
                              showToast('Failed to send follow request', 'error');
                            }
                          }}
                          className="px-5 py-2 bg-primary text-white text-xs font-bold rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-md flex items-center gap-2 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-sm font-bold">person_add</span>
                          <span>Follow {selectedChatPartner.name}</span>
                        </button>
                      )}
                    </footer>
                  );
                }

                return (
                  <footer className="bg-[#efeae2]/95 backdrop-blur-md px-3 py-3 border-t border-slate-200/20 flex items-center gap-2 z-40">
                    <div className="flex-1 flex items-center bg-white rounded-full px-3 py-1.5 shadow-sm border border-slate-200/50 min-h-[44px] transition-all focus-within:ring-2 focus-within:ring-primary/20">
                      {/* Emoji Button */}
                      <button
                        onClick={() => setInputText((prev) => prev + ' 😊')}
                        className="text-slate-400 hover:text-primary transition-colors active:scale-90 p-1.5 mr-0.5 rounded-full hover:bg-slate-50 flex items-center justify-center shrink-0 cursor-pointer"
                        title="Insert Emoji"
                      >
                        <span className="material-symbols-outlined text-[22px]">mood</span>
                      </button>

                      {/* Input field */}
                      <input
                        type="text"
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSendMessage();
                        }}
                        placeholder="Type a message..."
                        className="flex-1 bg-transparent border-none text-sm text-slate-800 placeholder:text-slate-400 outline-none font-medium py-1"
                      />

                      {/* Hidden File Input for Chat Attachments */}
                      <input
                        type="file"
                        ref={chatFileInputRef}
                        onChange={handleChatImageUpload}
                        accept="image/*"
                        className="hidden"
                      />

                      {/* Attachment Button */}
                      <button
                        onClick={() => chatFileInputRef.current?.click()}
                        className="text-slate-400 hover:text-primary transition-colors active:scale-90 p-1.5 mx-0.5 rounded-full hover:bg-slate-50 flex items-center justify-center shrink-0 cursor-pointer"
                        title="Attach File/Image"
                      >
                        <span className="material-symbols-outlined text-[20px] rotate-45">attach_file</span>
                      </button>

                      {/* Camera Button */}
                      <button
                        onClick={() => chatFileInputRef.current?.click()}
                        className="text-slate-400 hover:text-primary transition-colors active:scale-90 p-1.5 rounded-full hover:bg-slate-50 flex items-center justify-center shrink-0 cursor-pointer"
                        title="Take Photo"
                      >
                        <span className="material-symbols-outlined text-[20px]">photo_camera</span>
                      </button>
                    </div>

                    {/* Right Action Button (Send/Wave) */}
                    <button
                      onClick={() => {
                        if (inputText.trim()) {
                          handleSendMessage();
                        } else {
                          setInputText('👋');
                        }
                      }}
                      className="w-11 h-11 bg-primary text-white rounded-full flex items-center justify-center shadow-md active:scale-90 shrink-0 cursor-pointer hover:brightness-110 transition-all"
                      id="send-chat-btn"
                      title={inputText.trim() ? "Send Message" : "Send Wave"}
                    >
                      <span className="material-symbols-outlined text-[20px] font-bold">
                        {inputText.trim() ? 'send' : 'wave_gesture'}
                      </span>
                    </button>
                  </footer>
                );
              })()}
            </div>
          )}

          {/* ==================== 11. SCREEN: STORIES & SOCIAL DISCOVERY ==================== */}
          {currentScreen === 'stories' && (
            <div className="px-6 pt-4 space-y-5 animate-fade-in">

              {/* Search Bar */}
              <div className="space-y-3">
                <div className="rounded-full bg-white px-4 py-2.5 flex items-center gap-2.5 shadow-sm border border-slate-100">
                  <span className="material-symbols-outlined text-slate-400 text-lg">search</span>
                  <input
                    type="text"
                    value={homeSearchQuery}
                    onChange={(e) => setHomeSearchQuery(e.target.value)}
                    placeholder="Search people by username..."
                    className="bg-transparent border-none w-full text-xs text-on-surface placeholder:text-slate-400 outline-none"
                  />
                  {homeSearchQuery && (
                    <button onClick={() => setHomeSearchQuery('')} className="text-slate-400 hover:text-primary transition-all">
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  )}
                  <button onClick={() => navigateTo('onboarding_interests')} className="text-primary">
                    <span className="material-symbols-outlined text-lg">tune</span>
                  </button>
                </div>

                {/* Home Search Dropdown Results */}
                {homeSearchQuery.trim() !== '' && (
                  <div className="bg-white rounded-2xl p-4 shadow-md border border-slate-100 space-y-3 animate-fade-in max-h-60 overflow-y-auto scrollbar-hide text-left">
                    <h4 className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Search Results</h4>
                    {(() => {
                      const filtered = discoverPeople.filter((p) =>
                        (p.username || p.id).toLowerCase().includes(homeSearchQuery.toLowerCase()) ||
                        p.name.toLowerCase().includes(homeSearchQuery.toLowerCase())
                      );
                      if (filtered.length === 0) {
                        return <p className="text-xs text-slate-400 py-2">No users found with username "{homeSearchQuery}"</p>;
                      }
                      return filtered.map((person) => (
                        <div
                          key={person.id}
                          onClick={() => {
                            setSelectedDiscoverPerson(person);
                            const idx = discoverPeople.findIndex((p) => p.id === person.id);
                            if (idx !== -1) {
                              setActiveDiscoverIndex(idx);
                            }
                            setHomeSearchQuery('');
                            setActivePhotoIndex(0);
                            navigateTo('profile_details');
                          }}
                          className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 transition-all cursor-pointer border border-slate-50"
                        >
                          <div className="flex items-center gap-3">
                            <ProfileImage src={person.photo} name={person.name} className="w-9 h-9 rounded-full object-cover border border-slate-100 shadow-sm" />
                            <div className="flex flex-col">
                              <span className="text-xs font-bold text-slate-800 leading-tight">{person.name}</span>
                              <span className="text-[10px] text-slate-400">@{person.username || person.id}</span>
                            </div>
                          </div>
                          <span className="material-symbols-outlined text-primary text-sm">chevron_right</span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>

              {/* Stories Row */}
              {(() => {
                const combinedStories = dbStories;
                return (
                  <section className="space-y-2">
                    {/* Hidden upload input */}
                    <input
                      type="file"
                      ref={storyFileInputRef}
                      onChange={handleStoryUpload}
                      accept="image/*,video/*"
                      className="hidden"
                    />

                    <h3 className="text-xs font-bold text-slate-400 tracking-wider uppercase">Social Stories</h3>
                    <div className="flex gap-3 overflow-x-auto scrollbar-hide py-1">
                      {/* Your story slot */}
                      <div
                        onClick={() => {
                          const ownStories = dbStories.filter(s => s.userUid === auth.currentUser?.uid);
                          if (ownStories.length > 0) {
                            setStoryViewerList(ownStories);
                            setActiveStoryIndex(0);
                          } else {
                            storyFileInputRef.current?.click();
                          }
                        }}
                        className="flex flex-col items-center gap-1.5 flex-shrink-0 cursor-pointer relative group"
                      >
                        <div className="sunset-gradient-ring w-14 h-14 rounded-full flex items-center justify-center relative">
                          <div className="w-full h-full rounded-full border-2 border-white flex items-center justify-center bg-slate-50 overflow-hidden relative">
                            {(() => {
                              const ownStories = dbStories.filter(s => s.userUid === auth.currentUser?.uid);
                              if (ownStories.length > 0) {
                                return <img className="w-full h-full object-cover" src={ownStories[0].photo} alt="Your story" />;
                              } else {
                                return (
                                  <>
                                    <ProfileImage src={userProfile.photos?.[0]} name={userProfile.name} className="w-full h-full object-cover" alt="Your profile" />
                                    <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                                      <span className="material-symbols-outlined text-white text-base font-bold">add</span>
                                    </div>
                                  </>
                                );
                              }
                            })()}
                          </div>
                          {/* Absolute + badge to upload MORE stories even after posting one */}
                          {(() => {
                            const ownStories = dbStories.filter(s => s.userUid === auth.currentUser?.uid);
                            if (ownStories.length > 0) {
                              return (
                                <div
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    storyFileInputRef.current?.click();
                                  }}
                                  className="absolute -bottom-0.5 -right-0.5 w-5 h-5 bg-primary text-white rounded-full border border-white flex items-center justify-center shadow-md active:scale-90 transition-all cursor-pointer z-20"
                                  title="Add another story"
                                >
                                  <span className="material-symbols-outlined text-[14px] font-extrabold">add</span>
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                        <span className="text-[10px] text-slate-500 font-semibold">Your Story</span>
                      </div>

                      {/* Other stories */}
                      {(() => {
                        const otherStories = combinedStories.filter(s => s.userUid !== auth.currentUser?.uid);
                        return otherStories.map((story, idx) => (
                          <div
                            key={story.id}
                            onClick={() => {
                              setStoryViewerList(otherStories);
                              setActiveStoryIndex(idx);
                            }}
                            className="flex flex-col items-center gap-1.5 flex-shrink-0 cursor-pointer"
                          >
                            <div className="sunset-gradient-ring w-14 h-14 rounded-full flex items-center justify-center">
                              <div className="w-full h-full rounded-full border-2 border-white overflow-hidden">
                                <ProfileImage src={story.userPhoto || story.photo} name={story.name} className="w-full h-full object-cover" alt={story.name} />
                              </div>
                            </div>
                            <span className="text-[10px] text-slate-800 font-semibold">{story.name}</span>
                          </div>
                        ));
                      })()}
                    </div>


                  </section>
                );
              })()}

              {/* Sparks Connections requests */}
              <section className="space-y-3 bg-white p-4 rounded-3xl border border-slate-100 shadow-sm">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-xs font-bold text-slate-400 tracking-wider uppercase">New Sparks</h3>
                    <span className="bg-primary text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded-full">
                      {sparksList.filter((s) => s.status === 'pending').length}
                    </span>
                  </div>
                  
                  {/* Sparks Balance & Actions */}
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-0.5 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                      <span className="material-symbols-outlined text-[12px] font-bold">stars</span>
                      <span>{userSparks} Sparks ✨</span>
                    </span>
                  </div>
                </div>

                {/* Ad button */}
                <div className="w-full pb-1">
                  <button
                    onClick={() => {
                      setAdTimeLeft(2); // 2 second ad simulation
                      setWatchingAd(true);
                    }}
                    className="w-full bg-amber-500 text-white text-[10px] font-bold py-2 px-3 rounded-xl hover:bg-amber-600 transition-colors flex items-center justify-center gap-1 active:scale-95 cursor-pointer shadow-sm animate-pulse"
                  >
                    <span className="material-symbols-outlined text-xs">play_circle</span>
                    <span>Watch Ad (+5 ✨)</span>
                  </button>
                </div>

                <div className="flex gap-3 overflow-x-auto scrollbar-hide py-1">
                  {sparksList.map((spark) => (
                    <div
                      key={spark.id}
                      onClick={() => openSparkPopup(spark)}
                      className="bg-slate-50 border border-slate-100/80 rounded-2xl p-3 min-w-[130px] flex flex-col items-center text-center space-y-2 shadow-sm cursor-pointer hover:bg-slate-100/40 hover:border-slate-200 transition-all active:scale-98"
                    >
                      <div className="w-14 h-14 rounded-full overflow-hidden border border-primary-fixed">
                        <ProfileImage src={spark.photo} name={spark.name} className="w-full h-full object-cover" alt={spark.name} />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-on-surface leading-none">{spark.name}</p>
                        <p className="text-[9px] text-primary font-semibold mt-0.5">
                          {spark.status === 'pending'
                            ? 'Wants to connect'
                            : spark.status === 'accepted'
                            ? 'Connected ✓'
                            : 'Declined'}
                        </p>
                      </div>

                      {spark.status === 'pending' && (
                        <div className="flex justify-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSparkAction(spark.id, 'decline');
                            }}
                            className="w-7 h-7 rounded-full bg-slate-200/70 hover:bg-red-50 text-slate-500 hover:text-red-500 transition-colors flex items-center justify-center active:scale-90"
                          >
                            <span className="material-symbols-outlined text-[14px]">close</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSparkAction(spark.id, 'accept');
                            }}
                            className="w-7 h-7 rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-colors flex items-center justify-center active:scale-90"
                          >
                            <span className="material-symbols-outlined text-[14px]">favorite</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Suggested Profiles */}
              <section className="space-y-2">
                <h3 className="text-xs font-bold text-slate-400 tracking-wider uppercase">Suggested for you</h3>
                <div className="space-y-3">
                  {discoverPeople.slice(0, 5).map((s) => (
                    <div
                      key={s.id}
                      onClick={() => openUserProfile(s.id)}
                      className="relative w-full h-[340px] max-h-[340px] rounded-[24px] overflow-hidden group shadow-sm border border-slate-100 cursor-pointer hover:scale-[1.01] transition-transform duration-300"
                    >
                      <ProfileImage src={s.photo} name={s.name} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" alt={s.name} />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent"></div>

                      <div className="absolute bottom-0 inset-x-0 p-4 space-y-2">
                        <div className="flex justify-between items-end">
                          <div className="text-white text-left">
                            <h4 className="font-title-md text-lg leading-none">{s.name}, {s.age}</h4>
                            <p className="text-[10px] opacity-80 font-medium">Nearby</p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              showToast(`Sparking query with ${s.name}!`, "info");
                            }}
                            className="w-9 h-9 rounded-full bg-primary text-white shadow-lg flex items-center justify-center active:scale-90"
                          >
                            <span className="material-symbols-outlined text-sm">bolt</span>
                          </button>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          {(s.interests || []).map((tag) => (
                            <span key={tag} className="bg-white/20 text-white text-[8px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                  {discoverPeople.length === 0 && (
                    <p className="text-[10px] text-slate-400 italic py-2">No dynamic recommendations found</p>
                  )}
                </div>
              </section>

              {/* Social Activity */}
              <section className="space-y-2 pb-6">
                <h3 className="text-xs font-bold text-slate-400 tracking-wider uppercase">Social Activity</h3>
                <div className="space-y-2">
                  {dbStories.slice(0, 3).map((story) => (
                    <div
                      key={story.id}
                      onClick={() => openUserProfile(story.userUid)}
                      className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100/50 hover:bg-slate-100/50 cursor-pointer transition-all active:scale-99 text-left"
                    >
                      <div className="w-9 h-9 rounded-full overflow-hidden">
                        <ProfileImage src={story.userPhoto || story.photo} name={story.name} className="w-full h-full object-cover" alt={story.name} />
                      </div>
                      <div className="flex-1">
                        <p className="text-[11px] text-[#111d23] font-medium"><span className="font-bold">{story.name}</span> added a new story</p>
                        <p className="text-[9px] text-slate-400">Recently</p>
                      </div>
                      <div className="w-2 h-2 rounded-full bg-primary"></div>
                    </div>
                  ))}
                  {dbStories.length === 0 && (
                    <p className="text-[10px] text-slate-400 italic py-2">No recent social activities</p>
                  )}
                </div>
              </section>
            </div>
          )}

          {/* ==================== 12. SCREEN: EDIT PROFILE ==================== */}
          {currentScreen === 'edit_profile' && (
            <div className="absolute inset-0 bg-[#fafafa] flex flex-col animate-fade-in overflow-hidden z-[50]">
              {/* Header */}
              <header className="absolute top-0 left-0 right-0 z-50 bg-white/90 backdrop-blur-md flex justify-between items-center px-6 h-16 shadow-sm border-b border-slate-100">
                <button
                  onClick={() => {
                    const backScreen = (previousScreen && previousScreen !== 'edit_profile' && previousScreen !== 'welcome' && previousScreen !== 'signin') ? previousScreen : 'stories';
                    navigateTo(backScreen);
                  }}
                  className="text-primary active:scale-95"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
                <h1 className="font-title-md text-sm text-on-surface font-extrabold">Edit Profile</h1>
                <button
                  onClick={() => {
                    saveProfileToFirestore();
                    const backScreen = (previousScreen && previousScreen !== 'edit_profile' && previousScreen !== 'welcome' && previousScreen !== 'signin') ? previousScreen : 'stories';
                    navigateTo(backScreen);
                  }}
                  className="text-primary text-xs font-bold active:scale-95 cursor-pointer"
                  id="edit-profile-done-btn"
                >
                  Done
                </button>
              </header>

              {/* Toast notifier */}
              {saveSuccessToast && (
                <div className="absolute top-20 inset-x-6 z-[9999] bg-[#e3f0f8] border border-primary-fixed text-[#111d23] py-2 px-4 rounded-xl text-center shadow-lg font-semibold text-xs animate-bounce">
                  ✓ Profile Changes Saved Successfully!
                </div>
              )}

              {/* Scrollable body content container */}
              <div className="flex-1 overflow-y-auto px-6 pt-20 pb-24 space-y-6 text-left">
                {/* Photo selector grid */}
                <section className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2 row-span-2 relative aspect-square rounded-xl overflow-hidden card-shadow bg-slate-100">
                    <ProfileImage src={userProfile.photos[0]} name={userProfile.name} className="w-full h-full object-cover" alt="Primary user edit" />
                    <button
                      onClick={() => {
                        setPhotoSlotToEdit(0);
                        fileInputRef.current?.click();
                      }}
                      className="absolute bottom-2 right-2 bg-primary text-white w-8 h-8 rounded-full flex items-center justify-center shadow-lg cursor-pointer active:scale-90"
                    >
                      <span className="material-symbols-outlined text-[16px]">edit</span>
                    </button>
                  </div>

                  {[1, 2, 3, 4, 5].map((idx) => (
                    <div
                      key={idx}
                      onClick={() => {
                        setPhotoSlotToEdit(idx);
                        fileInputRef.current?.click();
                      }}
                      className="aspect-square bg-slate-100 rounded-xl border border-dashed border-[#e4bdc2] flex items-center justify-center cursor-pointer hover:bg-slate-200/50 overflow-hidden relative"
                    >
                      {userProfile.photos[idx] ? (
                        <>
                          <ProfileImage src={userProfile.photos[idx]} name={userProfile.name} className="w-full h-full object-cover rounded-xl" alt="upload preview" />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const updatedPhotos = [...userProfile.photos];
                              updatedPhotos.splice(idx, 1);
                              const updatedProfile = { ...userProfile, photos: updatedPhotos };
                              setUserProfile(updatedProfile);
                              saveProfileToFirestore(updatedProfile);
                            }}
                            className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white text-[10px] hover:bg-black cursor-pointer"
                          >
                            ×
                          </button>
                        </>
                      ) : (
                        <span className="material-symbols-outlined text-slate-400">add</span>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-center text-[10px] text-slate-400 font-medium">Click on slots to add or edit photos</p>
              </section>

              {/* Profile Completion percentage */}
              <section className="bg-[#e9f6fd] p-4 rounded-xl border border-primary-fixed/20 shadow-sm space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-primary font-bold">Profile 85% Complete</span>
                  <span className="text-[10px] text-slate-500">Almost there!</span>
                </div>
                <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full" style={{ width: '85%' }}></div>
                </div>
                <button
                  onClick={() => showToast("Simulation: video file uploaded!", "success")}
                  className="flex items-center gap-1.5 text-primary text-[10px] font-bold mt-1"
                >
                  <span className="material-symbols-outlined text-[16px]">videocam</span>
                  Add a video to reach 100%
                </button>
              </section>

              {/* Followers and Following Counts Panel */}
              <section className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex justify-around items-center text-center animate-fade-in">
                <button
                  onClick={() => openFollowList('followers', auth.currentUser?.uid || '', 'My')}
                  className="flex-1 border-r border-slate-100 py-1 hover:bg-slate-50 rounded-xl transition-all cursor-pointer"
                >
                  <span className="block text-lg font-extrabold text-slate-800 font-title-md">{ownFollowersCount}</span>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Followers</span>
                </button>
                <button
                  onClick={() => openFollowList('following', auth.currentUser?.uid || '', 'My')}
                  className="flex-1 py-1 hover:bg-slate-50 rounded-xl transition-all cursor-pointer"
                >
                  <span className="block text-lg font-extrabold text-slate-800 font-title-md">{ownFollowingCount}</span>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Following</span>
                </button>
              </section>

              {/* Share My Public Profile Panel */}
              <section className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm space-y-3 animate-fade-in">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-sm">share</span>
                  <h3 className="text-xs font-bold text-slate-800">Share My Public Profile</h3>
                </div>
                <p className="text-[10px] text-slate-400">
                  Allow others to view your professional bio, verified status, and aesthetic interests directly on the web.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const profileUrl = `${window.location.origin}/u/${userProfile.username || auth.currentUser?.uid}`;
                      if (navigator.share) {
                        navigator.share({
                          title: `${userProfile.name} (@${userProfile.username || 'user'}) on Aura`,
                          text: `Check out my profile on Aura!`,
                          url: profileUrl,
                        }).catch(() => {});
                      } else {
                        navigator.clipboard?.writeText(profileUrl);
                        showToast('Profile link copied to clipboard!', 'success');
                      }
                    }}
                    className="flex-1 py-2.5 bg-primary text-white rounded-xl text-xs font-bold hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-sm">ios_share</span>
                    <span>Share Link</span>
                  </button>
                  <button
                    onClick={() => {
                      const profileUrl = `${window.location.origin}/u/${userProfile.username || auth.currentUser?.uid}`;
                      setQrUrl(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(profileUrl)}`);
                      setShowQrModal(true);
                    }}
                    className="flex-1 py-2.5 border border-primary text-primary rounded-xl text-xs font-bold hover:bg-rose-50/50 active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-sm">qr_code_2</span>
                    <span>View QR Code</span>
                  </button>
                </div>
              </section>

              {/* Active Stories Section for current user */}
              {(() => {
                const ownStories = dbStories.filter(s => s.userUid === auth.currentUser?.uid);
                if (ownStories.length > 0) {
                  return (
                    <section className="space-y-2">
                      <h3 className="text-xs font-bold text-slate-700 block flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[18px] text-primary">auto_awesome_motion</span>
                        <span>My Active Stories</span>
                      </h3>
                      <div className="flex gap-2 overflow-x-auto scrollbar-hide py-1">
                        {ownStories.map((story, idx) => (
                          <div
                            key={story.id}
                            onClick={() => {
                              setStoryViewerList(ownStories);
                              setActiveStoryIndex(idx);
                            }}
                            className="relative w-20 h-32 rounded-xl overflow-hidden shrink-0 cursor-pointer border border-slate-100 shadow-xs hover:scale-105 transition-all"
                          >
                            <img src={story.photo} className="w-full h-full object-cover" alt="My story thumbnail" />
                            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>
                            <span className="absolute bottom-1 left-1.5 text-[9px] text-white font-bold max-w-[70px] truncate">
                              Story #{idx + 1}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                }
                return null;
              })()}

              {/* Bio description text area */}
              <section className="space-y-1.5">
                <h3 className="text-xs font-bold text-slate-700 block">About Me</h3>
                <div className="relative">
                  <textarea
                    value={userProfile.bio || ''}
                    onChange={(e) => setUserProfile({ ...userProfile, bio: e.target.value })}
                    className="w-full bg-white border border-slate-200 rounded-xl p-3 text-xs text-slate-700 focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all resize-none h-24"
                    maxLength={500}
                  ></textarea>
                  <div className="absolute bottom-2 right-2 text-slate-400 text-[9px]">
                    {(userProfile.bio || '').length}/500
                  </div>
                </div>
              </section>

              {/* Interests chips editor */}
              <section className="space-y-2">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold text-slate-700">My Interests</h3>
                  <button onClick={() => navigateTo('onboarding_interests')} className="text-xs text-primary font-bold">
                    Edit Tags
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {userProfile.interests.map((tag) => (
                    <span key={tag} className="bg-[#F3E5F5] text-[#263238] font-bold text-[9px] tracking-wide uppercase px-2.5 py-1 rounded-full">
                      {tag}
                    </span>
                  ))}
                </div>
              </section>

              {/* Prompts list editor */}
              <section className="space-y-2">
                <h3 className="text-xs font-bold text-slate-700">Profile Prompts</h3>
                <div className="space-y-3">
                  <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl space-y-2">
                    <p className="text-[10px] text-primary font-bold italic">My perfect Sunday...</p>
                    <p className="text-xs text-slate-800 font-bold leading-tight">Starts with fresh espresso, ends with a vinyl record.</p>
                    <div className="flex gap-2 pt-1 text-[10px] font-bold">
                      <button onClick={() => showToast("Simulation: change prompt", "info")} className="flex-1 py-1.5 bg-[#f4dce4] text-[#25181e] rounded-lg">Change Prompt</button>
                      <button onClick={() => showToast("Simulation: edit prompt value", "info")} className="flex-1 py-1.5 border border-primary text-primary rounded-lg">Edit Response</button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Basic input forms */}
              <section className="space-y-3">
                <h3 className="text-xs font-bold text-slate-700">Basic Info</h3>
                <div className="space-y-2 text-xs">
                  <div className="space-y-1">
                    <label className="text-slate-500 font-semibold">Username</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-semibold text-xs">@</span>
                      <input
                        type="text"
                        value={userProfile.username || ''}
                        onChange={(e) => setUserProfile({ ...userProfile, username: e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, '') })}
                        className="w-full bg-white border border-slate-200 rounded-xl pl-7 pr-3 py-2 outline-none focus:border-primary text-xs font-mono text-on-surface"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-slate-500 font-semibold">Display Name</label>
                    <input
                      type="text"
                      value={userProfile.name || ''}
                      onChange={(e) => setUserProfile({ ...userProfile, name: e.target.value })}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-primary text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-slate-500 font-semibold">Age</label>
                      <input
                        type="number"
                        value={userProfile.age !== undefined && userProfile.age !== null ? userProfile.age : ''}
                        onChange={(e) => setUserProfile({ ...userProfile, age: parseInt(e.target.value) || 18 })}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-primary text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-slate-500 font-semibold">Location</label>
                      <input
                        type="text"
                        value={userProfile.location || ''}
                        onChange={(e) => setUserProfile({ ...userProfile, location: e.target.value })}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-primary text-xs"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-slate-500 font-semibold">Profession</label>
                    <input
                      type="text"
                      value={userProfile.profession || ''}
                      onChange={(e) => setUserProfile({ ...userProfile, profession: e.target.value })}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-primary text-xs"
                    />
                  </div>
                </div>
              </section>

              {/* Account, monetization & premium status link buttons */}
              <section className="space-y-2 pt-2 pb-6">
                <h3 className="text-xs font-bold text-slate-700">Account Settings</h3>
                <div className="space-y-2 text-xs">
                  {/* Premium subscription tier selector link */}
                  <div
                    onClick={() => navigateTo('aura_gold')}
                    className="bg-white border border-slate-200/60 p-3.5 rounded-xl cursor-pointer hover:bg-slate-50 flex items-center justify-between shadow-sm active:scale-98"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-yellow-100 flex items-center justify-center text-yellow-600">
                        <span className="material-symbols-outlined text-sm">star</span>
                      </div>
                      <div className="flex flex-col text-left">
                        <span className="font-bold text-slate-800 flex items-center gap-1.5">
                          Aura Premium Tier
                          <span className="bg-[#b80049] text-white text-[8px] font-bold px-1 rounded">VIP</span>
                        </span>
                        <p className="text-[10px] text-slate-400">Upgrade for unlimited sparks and see who likes you</p>
                      </div>
                    </div>
                    <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                  </div>

                  {/* Creator monetization panel link */}
                  <div
                    onClick={() => navigateTo('creator_monetization')}
                    className="bg-white border border-slate-200/60 p-3.5 rounded-xl cursor-pointer hover:bg-slate-50 flex items-center justify-between shadow-sm active:scale-98"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#fce4ec] flex items-center justify-center text-primary">
                        <span className="material-symbols-outlined text-sm">payments</span>
                      </div>
                      <div className="flex flex-col text-left">
                        <span className="font-bold text-slate-800 flex items-center gap-1.5">
                          Creator Revenue
                          <span className="bg-[#ea4335] text-white text-[8px] font-bold px-1 rounded">HOT</span>
                        </span>
                        <p className="text-[10px] text-slate-400">Track and request payouts on ad earnings</p>
                      </div>
                    </div>
                    <span className="material-symbols-outlined text-slate-400 text-sm">chevron_right</span>
                  </div>

                  {/* PostgreSQL User Data Tracking Hub (Admin Only) */}
                  {userProfile.role === 'admin' && (
                    <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 p-4 rounded-xl shadow-sm text-left space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-emerald-600">database</span>
                          <h4 className="font-bold text-slate-800 text-xs">PostgreSQL Tracking Hub</h4>
                        </div>
                        <span className="bg-emerald-500 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider">Active</span>
                      </div>

                      <p className="text-[10px] text-slate-500 leading-relaxed">
                        Every swipe, profile update, page navigation, and message is recorded securely in your **Cloud SQL PostgreSQL database**.
                      </p>

                      {loadingTracking ? (
                        <div className="text-[10px] text-slate-400 py-1 flex items-center gap-1.5">
                          <span className="animate-spin material-symbols-outlined text-xs">sync</span> Loading analytics...
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {/* Event Stats summary */}
                          <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                            <div className="bg-white/80 p-1.5 rounded-lg border border-slate-100">
                              <span className="block font-mono font-bold text-emerald-600 text-xs">
                                {trackingLogs.filter(l => l.eventType === 'page_view').length}
                              </span>
                              <span className="text-[8px] text-slate-400 uppercase font-semibold">Views</span>
                            </div>
                            <div className="bg-white/80 p-1.5 rounded-lg border border-slate-100">
                              <span className="block font-mono font-bold text-emerald-600 text-xs">
                                {trackingLogs.filter(l => l.eventType.startsWith('swipe')).length}
                              </span>
                              <span className="text-[8px] text-slate-400 uppercase font-semibold">Swipes</span>
                            </div>
                            <div className="bg-white/80 p-1.5 rounded-lg border border-slate-100">
                              <span className="block font-mono font-bold text-emerald-600 text-xs">
                                {trackingLogs.filter(l => l.eventType === 'send_message').length}
                              </span>
                              <span className="text-[8px] text-slate-400 uppercase font-semibold">Chats</span>
                            </div>
                          </div>

                          {/* Event list */}
                          <div className="max-h-36 overflow-y-auto border border-slate-100/80 rounded-lg bg-white/95 p-2 space-y-1.5 scrollbar-hide">
                            {trackingLogs.length === 0 ? (
                              <p className="text-[10px] text-slate-400 text-center py-4">No tracking data synced yet. Start exploring!</p>
                            ) : (
                              trackingLogs.slice(0, 15).map((log, lIdx) => (
                                <div key={log.id || lIdx} className="text-[9px] flex justify-between items-start border-b border-slate-100/50 pb-1 last:border-0 last:pb-0">
                                  <div className="space-y-0.5">
                                    <div className="flex items-center gap-1">
                                      <span className="bg-emerald-100 text-emerald-800 font-bold px-1 rounded-sm text-[7px] uppercase">
                                        {log.eventType.replace('_', ' ')}
                                      </span>
                                      {log.screenName && (
                                        <span className="text-slate-400 font-mono text-[7px]">@{log.screenName}</span>
                                      )}
                                    </div>
                                    {log.details && (
                                      <p className="text-slate-600 line-clamp-1 break-all text-[8px]">{log.details}</p>
                                    )}
                                  </div>
                                  <span className="text-[8px] text-slate-400 font-mono">
                                    {log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Privacy & Data Settings */}
                  <section className="space-y-2 pt-2 pb-6">
                    <h3 className="text-xs font-bold text-slate-700">Privacy & Data</h3>
                    <div className="space-y-2.5 text-xs">
                      {/* Blocked Users Section */}
                      <div className="bg-white border border-slate-200/60 p-4 rounded-xl shadow-sm text-left space-y-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600">
                            <span className="material-symbols-outlined text-sm">block</span>
                          </div>
                          <div className="flex-1">
                            <span className="font-bold text-slate-800 text-xs">Blocked Users</span>
                            <p className="text-[10px] text-slate-400">Manage and unblock people you've restricted</p>
                          </div>
                        </div>

                        {loadingBlocked ? (
                          <div className="text-[10px] text-slate-400 py-1 flex items-center gap-1.5 justify-center">
                            <span className="animate-spin material-symbols-outlined text-xs">sync</span> Loading blocked users...
                          </div>
                        ) : blockedUsers.length === 0 ? (
                          <p className="text-[10px] text-slate-400 italic py-1 text-center bg-slate-50/50 rounded-lg">No blocked users</p>
                        ) : (
                          <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-hide bg-slate-50/40 p-2 rounded-lg border border-slate-100">
                            {blockedUsers.map((user) => (
                              <div key={user.uid} className="flex items-center justify-between gap-2 border-b border-slate-100/50 pb-2 last:border-0 last:pb-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="w-7 h-7 rounded-full overflow-hidden border border-slate-200 bg-slate-100">
                                    <ProfileImage src={user.photo} name={user.name} className="w-full h-full object-cover" />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="block font-bold text-slate-800 text-[11px] truncate leading-none">{user.name}</span>
                                    <span className="text-[9px] text-slate-400 font-mono">@{user.username || user.uid.slice(0, 6)}</span>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleUnblockUser(user.uid)}
                                  className="bg-primary hover:bg-primary-hover text-white text-[9px] font-bold px-2 py-1 rounded-lg transition-colors active:scale-95 shrink-0 cursor-pointer"
                                >
                                  Unblock
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Public Profile toggle & Data buttons */}
                      <div className="bg-white border border-slate-200/60 p-4 rounded-xl shadow-sm text-left space-y-3.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center text-blue-600">
                              <span className="material-symbols-outlined text-sm">link</span>
                            </div>
                            <div>
                              <span className="font-bold text-slate-800 text-xs">Public Profile Link</span>
                              <p className="text-[10px] text-slate-400">Allow others to view profile without app login</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={togglePublicProfile}
                            className={`w-10 h-6 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
                              (userProfile as any).publicProfileLink ? 'bg-primary' : 'bg-slate-200'
                            }`}
                          >
                            <div
                              className={`w-5 h-5 rounded-full bg-white shadow-md transform transition-transform duration-200 ${
                                (userProfile as any).publicProfileLink ? 'translate-x-4' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        </div>

                        {/* Download and Delete Actions */}
                        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
                          <button
                            type="button"
                            onClick={downloadMyData}
                            className="bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 font-bold py-2 px-3 rounded-xl transition-colors text-[10px] flex items-center justify-center gap-1.5 active:scale-98 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-xs">download</span>
                            Download Data
                          </button>
                          <button
                            type="button"
                            onClick={handleDeleteAccount}
                            className="bg-red-50 hover:bg-red-100 border border-red-100 text-red-600 font-bold py-2 px-3 rounded-xl transition-colors text-[10px] flex items-center justify-center gap-1.5 active:scale-98 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-xs">delete_forever</span>
                            Delete Account
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Sign Out Action Button */}
                  <div
                    onClick={handleLogout}
                    className="bg-white border border-red-200 p-3.5 rounded-xl cursor-pointer hover:bg-red-50 flex items-center justify-between shadow-sm active:scale-98"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center text-red-600">
                        <span className="material-symbols-outlined text-sm">logout</span>
                      </div>
                      <div className="flex flex-col text-left">
                        <span className="font-bold text-red-800">Sign Out</span>
                        <p className="text-[10px] text-red-400/85">Logout of your Aura account securely</p>
                      </div>
                    </div>
                    <span className="material-symbols-outlined text-red-400 text-sm">chevron_right</span>
                  </div>
                </div>
              </section>

              {/* Quick floating action Save Button at bottom */}
              <div className="pt-2 pb-10 flex justify-center">
                <button
                  onClick={() => {
                    saveProfileToFirestore();
                  }}
                  className="w-full bg-primary text-white font-title-md py-3 rounded-full shadow-lg glow-button hover:brightness-110 active:scale-95 transition-transform flex items-center justify-center gap-1.5 text-xs font-bold cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">check_circle</span>
                  <span>Save Changes</span>
                </button>
              </div>
              </div> {/* End scrollable body container */}
            </div>
          )}

          {/* ==================== 13. SCREEN: CREATOR REVENUE MONETIZATION ==================== */}
          {currentScreen === 'creator_monetization' && (
            <div className="px-6 pt-4 space-y-6 animate-fade-in pb-12">
              {/* Header */}
              <header className="flex justify-between items-center h-10 w-full mb-1">
                <button onClick={() => navigateTo('edit_profile')} className="text-primary active:scale-90">
                  <span className="material-symbols-outlined">arrow_back</span>
                </button>
                <h1 className="font-title-md text-base text-[#111d23] font-bold">Creator Revenue</h1>
                <button onClick={() => navigateTo('stories')} className="text-primary active:scale-90">
                  <span className="material-symbols-outlined">settings</span>
                </button>
              </header>

              {(() => {
                const followerCount = ownFollowersCount;
                const isLocked = followerCount < 1000;

                if (isLocked) {
                  const percent = Math.min(100, Math.round((followerCount / 1000) * 100));
                  return (
                    <div className="flex flex-col items-center justify-center py-10 text-center space-y-6">
                      <div className="relative">
                        <div className="w-24 h-24 rounded-full bg-rose-50 flex items-center justify-center text-primary animate-pulse">
                          <span className="material-symbols-outlined text-4xl fill-icon">lock</span>
                        </div>
                        <span className="absolute -bottom-1 -right-1 bg-amber-500 text-white rounded-full p-1.5 flex items-center justify-center border-2 border-white shadow-md">
                          <span className="material-symbols-outlined text-xs font-bold">lock_open</span>
                        </span>
                      </div>

                      <div className="space-y-2 max-w-[280px]">
                        <h3 className="text-base font-extrabold text-[#111d23] font-title-md">Creator Revenue Locked</h3>
                        <p className="text-xs text-slate-500 leading-relaxed font-semibold text-rose-600">
                          Reach 1,000 followers to unlock Creator Revenue.
                        </p>
                      </div>

                      {/* Progress bar to unlock */}
                      <div className="w-full bg-white border border-slate-100 p-4.5 rounded-2xl shadow-sm space-y-3">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-bold text-slate-600">Your Followers</span>
                          <span className="font-mono font-bold text-primary">{followerCount} / 1,000</span>
                        </div>
                        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                          <div 
                            className="bg-primary h-full rounded-full transition-all duration-1000"
                            style={{ width: `${percent}%` }}
                          ></div>
                        </div>
                        <p className="text-[9px] text-slate-400 text-left leading-relaxed">
                          Once you reach 1,000 followers, ads monetization and passive revenue sharing will be automatically enabled on all your shared stories.
                        </p>
                      </div>
                    </div>
                  );
                }

                return (
                  <>
                    {/* Total earnings cards details */}
                    <section className="relative overflow-hidden rounded-2xl p-5 text-white bg-gradient-to-br from-[#E91E63] to-[#C2185B] shadow-lg">
                      <div className="relative z-10 space-y-1">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-white/90">Total Earnings</p>
                        <h2 className="font-title-md text-3xl font-extrabold text-white">$1,240.50</h2>
                        <div className="flex items-center gap-1.5 pt-2 text-[10px]">
                          <span className="bg-white/20 px-2 py-0.5 rounded-full font-bold flex items-center gap-0.5">
                            <span className="material-symbols-outlined text-[10px]">trending_up</span> +12.4%
                          </span>
                          <span className="text-white/70">vs last month</span>
                        </div>
                      </div>
                      <div className="absolute -right-8 -top-8 w-32 h-32 bg-white/10 rounded-full blur-2xl"></div>
                    </section>

                    {/* Milestone unlocked card details banner */}
                    <div className="bg-[#f4dce4] rounded-xl p-3.5 flex items-center gap-3.5 border border-[#e4bdc2]/20">
                      <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center text-primary">
                        <span className="material-symbols-outlined text-lg fill-icon">stars</span>
                      </div>
                      <div className="text-left">
                        <p className="text-xs text-[#111d23] font-bold leading-tight">1,000+ Followers reached!</p>
                        <p className="text-[9px] text-[#524249] leading-tight">Ads Enabled • Revenue sharing is active</p>
                      </div>
                    </div>

                    {/* Ad Revenue interactive chart */}
                    <section className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm space-y-4">
                      <div className="flex justify-between items-center">
                        <h3 className="text-xs font-bold text-[#111d23]">Ad Revenue History</h3>
                        <span className="material-symbols-outlined text-slate-400 text-sm hover:text-primary cursor-pointer">info</span>
                      </div>

                      {/* Performance Graph bar chart mock */}
                      <div className="h-28 bg-[#f4faff] rounded-xl p-3 flex items-end justify-between overflow-hidden relative border border-slate-200/40">
                        <div className="absolute inset-0 flex items-center justify-center opacity-5 pointer-events-none select-none">
                          <span className="text-sm font-bold tracking-widest italic">AURA</span>
                        </div>
                        {/* Bars representing weekly payout metrics */}
                        <div className="w-[8%] bg-primary/20 rounded-t-full h-[40%]" title="Week 1"></div>
                        <div className="w-[8%] bg-primary/30 rounded-t-full h-[65%]" title="Week 2"></div>
                        <div className="w-[8%] bg-primary/40 rounded-t-full h-[55%]" title="Week 3"></div>
                        <div className="w-[8%] bg-primary/60 rounded-t-full h-[80%]" title="Week 4"></div>
                        <div className="w-[8%] bg-primary/50 rounded-t-full h-[45%]" title="Week 5"></div>
                        <div className="w-[8%] bg-primary/80 rounded-t-full h-[90%]" title="Week 6"></div>
                        <div className="w-[8%] bg-primary rounded-t-full h-[100%]" title="Week 7"></div>
                        <div className="w-[8%] bg-primary/40 rounded-t-full h-[60%]" title="Week 8"></div>
                        <div className="w-[8%] bg-primary/20 rounded-t-full h-[30%]" title="Week 9"></div>
                      </div>

                      {/* Metrics */}
                      <div className="grid grid-cols-3 gap-2 text-center pt-1 border-t border-slate-100">
                        <div>
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Impressions</p>
                          <p className="text-xs font-bold text-slate-800">42.8k</p>
                        </div>
                        <div>
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">CPM</p>
                          <p className="text-xs font-bold text-slate-800">$4.12</p>
                        </div>
                        <div>
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Share</p>
                          <p className="text-xs font-bold text-slate-800">45%</p>
                        </div>
                      </div>
                    </section>

                    {/* Recent payouts history log */}
                    <section className="space-y-3">
                      <div className="flex justify-between items-center">
                        <h3 className="text-xs font-bold text-slate-800">Recent Payouts</h3>
                        <button onClick={() => showToast("Simulation: Full statement is locked.", "info")} className="text-primary text-[10px] font-bold hover:underline">
                          View All
                        </button>
                      </div>

                      <div className="space-y-2">
                        <div className="bg-white border border-slate-100 flex items-center justify-between p-3.5 rounded-xl shadow-sm">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center text-primary">
                              <span className="material-symbols-outlined text-base">account_balance_wallet</span>
                            </div>
                            <div className="text-left">
                              <p className="text-xs text-slate-800 font-bold leading-none">October Payout</p>
                              <p className="text-[9px] text-slate-400 mt-1">Oct 28, 2026</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-bold text-slate-800 leading-none">$412.20</p>
                            <p className="text-[9px] font-bold text-green-600 mt-1 uppercase">Completed</p>
                          </div>
                        </div>

                        <div className="bg-white border border-slate-100 flex items-center justify-between p-3.5 rounded-xl shadow-sm">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center text-primary">
                              <span className="material-symbols-outlined text-base">account_balance_wallet</span>
                            </div>
                            <div className="text-left">
                              <p className="text-xs text-slate-800 font-bold leading-none">September Payout</p>
                              <p className="text-[9px] text-slate-400 mt-1">Sep 28, 2026</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-bold text-slate-800 leading-none">$385.15</p>
                            <p className="text-[9px] font-bold text-green-600 mt-1 uppercase">Completed</p>
                          </div>
                        </div>
                      </div>
                    </section>

                    {/* Request Payout trigger and state simulation */}
                    <div className="pt-2">
                      {payoutStatus === 'idle' ? (
                        <button
                          onClick={() => {
                            setPayoutStatus('loading');
                            setTimeout(() => setPayoutStatus('success'), 2000);
                          }}
                          className="w-full py-3 bg-primary text-white rounded-full font-bold shadow-md hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-1.5 text-xs uppercase"
                        >
                          <span className="material-symbols-outlined text-base">payments</span>
                          <span>Request Payout</span>
                        </button>
                      ) : payoutStatus === 'loading' ? (
                        <button className="w-full py-3 bg-primary/70 text-white rounded-full font-bold shadow-md cursor-not-allowed flex items-center justify-center gap-2 text-xs uppercase">
                          <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                          <span>Processing Payout...</span>
                        </button>
                      ) : (
                        <div className="w-full py-3.5 bg-green-100 text-green-800 rounded-xl border border-green-200 text-center font-bold text-xs">
                          ✓ Payout of $1,240.50 Requested successfully!
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* ==================== SCREEN: NOTIFICATIONS ==================== */}
          {currentScreen === 'notifications' && (
            <div className="px-6 pt-4 space-y-6 animate-fade-in pb-24 h-full overflow-y-auto scrollbar-hide">
              {/* Clear All button without header container */}
              <div className="flex justify-end pr-2">
                <button
                  onClick={() => {
                    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
                  }}
                  className="text-primary text-[10px] font-bold uppercase tracking-wider hover:underline cursor-pointer"
                >
                  Clear All
                </button>
              </div>

              {/* Notification List */}
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                  <div className="w-16 h-16 rounded-full bg-slate-50 flex items-center justify-center text-slate-300">
                    <span className="material-symbols-outlined text-3xl">notifications_off</span>
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-slate-700">No Notifications</h3>
                    <p className="text-[10px] text-slate-400 font-normal">We'll alert you when someone follows you back or likes your posts.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {notifications.map((notif) => {
                    const isMutual = isMutualFollower(notif.senderId);
                    return (
                      <div
                        key={notif.id}
                        onClick={() => {
                          setNotifications((prev) =>
                            prev.map((n) => (n.id === notif.id ? { ...n, read: true } : n))
                          );
                          if (notif.senderId) {
                            openUserProfile(notif.senderId);
                          }
                        }}
                        className={`p-4 rounded-2xl border transition-all flex gap-3.5 relative overflow-hidden cursor-pointer hover:bg-slate-50/80 ${
                          notif.read
                            ? 'bg-white border-slate-100 shadow-sm'
                            : 'bg-rose-50/40 border-rose-100/40 shadow-sm ring-1 ring-rose-500/5'
                        }`}
                      >
                        {/* Avatar */}
                        <div className="relative flex-shrink-0">
                          <img
                            src={notif.senderPhoto}
                            alt={notif.senderName}
                            className="w-11 h-11 rounded-full object-cover border border-slate-100"
                          />
                          {!notif.read && (
                            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border-2 border-white animate-pulse"></span>
                          )}
                        </div>

                        {/* Content */}
                        <div className="flex-1 space-y-2">
                          <div className="space-y-0.5 text-left">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-slate-800 font-title-md">
                                {notif.senderName}
                              </span>
                              <span className="text-[8px] text-slate-400 font-medium">
                                {new Date(notif.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            <p className="text-[10.5px] text-slate-500 leading-relaxed font-normal">
                              {notif.message}
                            </p>
                          </div>

                          {/* Action buttons */}
                          {notif.type === 'follow' && (
                            <div className="flex items-center gap-2 pt-1 flex-wrap">
                              {isMutual ? (
                                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-50 text-green-700 text-[10px] font-bold">
                                  <span className="material-symbols-outlined text-[13px] font-bold">check_circle</span>
                                  <span>Mutual Connection!</span>
                                </div>
                              ) : (
                                <>
                                  <button
                                    disabled={processingNotifications[notif.id]}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (processingNotifications[notif.id]) return;
                                      setProcessingNotifications(prev => ({ ...prev, [notif.id]: true }));
                                      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
                                      try {
                                        const res = await fetchFromBackend('/api/follows/accept', {
                                          method: 'POST',
                                          body: JSON.stringify({ followerUid: notif.senderId })
                                        });
                                        if (res.ok) {
                                          showToast('Follow request accepted!', 'success');
                                          await fetchFromBackend('/api/notifications/read', {
                                            method: 'POST',
                                            body: JSON.stringify({ id: notif.id })
                                          });
                                          fetchNotifications();
                                          fetchRecentChats();
                                        } else {
                                          setProcessingNotifications(prev => ({ ...prev, [notif.id]: false }));
                                        }
                                      } catch (err) {
                                        showToast('Failed to accept follow request', 'error');
                                        setProcessingNotifications(prev => ({ ...prev, [notif.id]: false }));
                                      }
                                    }}
                                    className={`px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold rounded-xl shadow-md active:scale-95 transition-all flex items-center gap-1 cursor-pointer ${
                                      processingNotifications[notif.id] ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
                                    }`}
                                  >
                                    <span className="material-symbols-outlined text-[12px] font-bold">check</span>
                                    <span>{processingNotifications[notif.id] ? 'Accepting...' : 'Accept'}</span>
                                  </button>

                                  <button
                                    disabled={processingNotifications[notif.id]}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (processingNotifications[notif.id]) return;
                                      setProcessingNotifications(prev => ({ ...prev, [notif.id]: true }));
                                      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
                                      try {
                                        const res = await fetchFromBackend('/api/follows/decline', {
                                          method: 'POST',
                                          body: JSON.stringify({ followerUid: notif.senderId })
                                        });
                                        if (res.ok) {
                                          showToast('Follow request declined.', 'info');
                                          await fetchFromBackend('/api/notifications/read', {
                                            method: 'POST',
                                            body: JSON.stringify({ id: notif.id })
                                          });
                                          fetchNotifications();
                                        } else {
                                          setProcessingNotifications(prev => ({ ...prev, [notif.id]: false }));
                                        }
                                      } catch (err) {
                                        showToast('Failed to decline follow request', 'error');
                                        setProcessingNotifications(prev => ({ ...prev, [notif.id]: false }));
                                      }
                                    }}
                                    className={`px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold rounded-xl shadow-md active:scale-95 transition-all flex items-center gap-1 cursor-pointer ${
                                      processingNotifications[notif.id] ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
                                    }`}
                                  >
                                    <span className="material-symbols-outlined text-[12px] font-bold">close</span>
                                    <span>{processingNotifications[notif.id] ? 'Declining...' : 'Decline'}</span>
                                  </button>
                                </>
                              )}
                              
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await fetchFromBackend('/api/notifications/read', {
                                    method: 'POST',
                                    body: JSON.stringify({ id: notif.id })
                                  });
                                  fetchNotifications();

                                  const partner = {
                                    id: notif.senderId,
                                    name: notif.senderName,
                                    photo: notif.senderPhoto,
                                    username: notif.senderUsername
                                  };
                                  setSelectedChatPartner(partner);
                                  navigateTo('chat');
                                }}
                                className="px-3 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-600 text-[10px] font-bold rounded-xl border border-slate-200/50 active:scale-95 transition-all cursor-pointer"
                              >
                                View Chat
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ==================== 14. SCREEN: AURA GOLD PLAN ==================== */}
          {currentScreen === 'aura_gold' && (
            <div className="absolute inset-0 bg-[#263238] text-white flex flex-col justify-between py-12 px-6 overflow-y-auto scrollbar-hide animate-fade-in z-20">
              {/* Header */}
              <header className="flex justify-between items-center w-full pb-4">
                <button onClick={() => navigateTo('edit_profile')} className="text-primary-fixed active:scale-90">
                  <span className="material-symbols-outlined text-white">arrow_back</span>
                </button>
                <h1 className="font-title-md text-sm text-[#ffb2be] tracking-[0.25em] font-extrabold uppercase">AURA GOLD</h1>
                <button onClick={() => showToast("Help and explanations can be found in our VIP Guide.", "info")} className="text-primary-fixed active:scale-90">
                  <span className="material-symbols-outlined text-white">help_outline</span>
                </button>
              </header>

              {/* Hero */}
              <section className="text-center space-y-1 my-2">
                <h1 className="font-title-md text-2xl rose-gold-text font-extrabold">Elevate Your Connection</h1>
                <p className="text-slate-300 text-xs px-2 leading-relaxed">
                  Experience Aura without limits. Designed for those who value depth and exclusivity.
                </p>
              </section>

              {/* Premium features bento grid */}
              <section className="grid grid-cols-2 gap-3.5 my-4">
                <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-4 text-center space-y-2 flex flex-col items-center">
                  <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center text-primary-fixed">
                    <span className="material-symbols-outlined text-xl fill-icon">auto_awesome</span>
                  </div>
                  <h3 className="font-title-md text-xs text-[#ffb2be] font-bold">Unlimited Sparks</h3>
                  <p className="text-[9px] text-slate-300 leading-normal">Ignite conversations without daily caps.</p>
                </div>

                <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-4 text-center space-y-2 flex flex-col items-center">
                  <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center text-primary-fixed">
                    <span className="material-symbols-outlined text-xl fill-icon">favorite</span>
                  </div>
                  <h3 className="font-title-md text-xs text-[#ffb2be] font-bold">See Who Liked You</h3>
                  <p className="text-[9px] text-slate-300 leading-normal">No more guessing. View your secret admirers.</p>
                </div>

                <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-4 text-center space-y-2 flex flex-col items-center">
                  <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center text-primary-fixed">
                    <span className="material-symbols-outlined text-xl">tune</span>
                  </div>
                  <h3 className="font-title-md text-xs text-[#ffb2be] font-bold">Advanced Filters</h3>
                  <p className="text-[9px] text-slate-300 leading-normal">Refine your search with elite criteria.</p>
                </div>

                <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-4 text-center space-y-2 flex flex-col items-center">
                  <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center text-primary-fixed">
                    <span className="material-symbols-outlined text-xl fill-icon">bolt</span>
                  </div>
                  <h3 className="font-title-md text-xs text-[#ffb2be] font-bold">Profile Boost</h3>
                  <p className="text-[9px] text-slate-300 leading-normal">Be seen by 10x more people in your area.</p>
                </div>
              </section>

              {/* Plans selector details */}
              <section className="space-y-3">
                <h4 className="text-center text-[#ffb2be] font-bold text-xs uppercase tracking-widest">Choose Your Journey</h4>

                {/* Yearly */}
                <div
                  onClick={() => setSelectedPlan('yearly')}
                  className={`bg-white/5 p-4.5 rounded-2xl relative cursor-pointer border transition-all duration-300 ${
                    selectedPlan === 'yearly'
                      ? 'border-[#ffb2be] ring-1 ring-[#ffb2be] scale-[1.01]'
                      : 'border-white/10 hover:border-white/30'
                  }`}
                >
                  <div className="absolute -top-2.5 right-4 bg-primary text-white text-[8px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">
                    SAVE 45%
                  </div>
                  <div className="flex justify-between items-center text-left">
                    <div>
                      <h4 className="text-xs font-extrabold text-white">Yearly Plan</h4>
                      <p className="text-[9px] text-slate-400">Billed annually</p>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-extrabold text-[#ffb2be]">$99.99</span>
                      <span className="text-[9px] block opacity-60">≈ $8.33/mo</span>
                    </div>
                  </div>
                </div>

                {/* Monthly */}
                <div
                  onClick={() => setSelectedPlan('monthly')}
                  className={`bg-white/5 p-4.5 rounded-2xl relative cursor-pointer border transition-all duration-300 ${
                    selectedPlan === 'monthly'
                      ? 'border-[#ffb2be] ring-1 ring-[#ffb2be] scale-[1.01]'
                      : 'border-white/10 hover:border-white/30'
                  }`}
                >
                  <div className="flex justify-between items-center text-left">
                    <div>
                      <h4 className="text-xs font-extrabold text-white">Monthly Plan</h4>
                      <p className="text-[9px] text-slate-400">Cancel anytime</p>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-extrabold text-[#ffb2be]">$14.99</span>
                      <span className="text-[9px] block opacity-60">per month</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* CTA upgrades button trigger */}
              <section className="text-center pt-4 space-y-3">
                <button
                  onClick={() => {
                    setGoldShadowSuccess(true);
                    setGoldUser(true);
                  }}
                  className="glow-button w-full py-3.5 bg-primary text-white font-bold rounded-2xl text-xs uppercase"
                >
                  Upgrade to Gold
                </button>

                <div className="flex items-center justify-center gap-1.5 text-[9px] text-slate-400">
                  <span className="material-symbols-outlined text-xs">lock</span>
                  <p>Safe, secure & private transactions</p>
                </div>

                <p className="text-[8px] text-slate-500 leading-normal px-2">
                  Subscription automatically renews for the same price and duration period until you cancel in settings. By tapping 'Upgrade', your payment will be charged to your store account. You agree to our Terms and Privacy Policy.
                </p>
              </section>

              {/* Success celebration gold modal */}
              {goldSuccess && (
                <div className="fixed inset-0 bg-[#263238] z-[1000] flex items-center justify-center p-8 animate-fade-in text-center">
                  <div className="space-y-6">
                    <div className="w-20 h-20 bg-primary/20 rounded-full flex items-center justify-center mx-auto shadow-2xl animate-float">
                      <span className="material-symbols-outlined text-[#ffb2be] text-4xl fill-icon">star</span>
                    </div>
                    <div className="space-y-2">
                      <h2 className="font-title-md text-2xl text-[#ffb2be] font-extrabold">Welcome to Gold</h2>
                      <p className="text-xs text-slate-300">Your premium journey starts now.</p>
                    </div>
                    <button
                      onClick={() => {
                        setGoldShadowSuccess(false);
                        navigateTo('discover');
                      }}
                      className="bg-primary text-white px-8 py-3 rounded-full text-xs font-bold uppercase active:scale-95 shadow-lg"
                    >
                      Start Exploring
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Global Bottom Sticky Tab Bar (For feed contexts only: stories, discover, chat, edit_profile, creator_monetization) */}
      {['discover', 'stories', 'edit_profile', 'chat', 'notifications'].includes(currentScreen) && !showDesktopLayout && (
          <nav className="absolute bottom-0 left-0 w-full z-40 bg-white/95 backdrop-blur-md h-[72px] flex justify-around items-center border-t border-slate-100 px-4 select-none pb-4">
            <button
              onClick={() => navigateTo('stories')}
              className={`flex flex-col items-center justify-center flex-1 py-1.5 ${
                currentScreen === 'stories' ? 'text-primary scale-105' : 'text-slate-400 hover:text-primary'
              }`}
            >
              <span className={`material-symbols-outlined text-[22px] ${currentScreen === 'stories' ? 'fill-icon' : ''}`}>home</span>
              <span className="text-[9px] font-bold leading-none mt-0.5">Home</span>
            </button>

            <button
              onClick={() => navigateTo('discover')}
              className={`flex flex-col items-center justify-center flex-1 py-1.5 ${
                currentScreen === 'discover' ? 'text-primary scale-105' : 'text-slate-400 hover:text-primary'
              }`}
            >
              <span className={`material-symbols-outlined text-[22px] ${currentScreen === 'discover' ? 'fill-icon' : ''}`}>explore</span>
              <span className="text-[9px] font-bold leading-none mt-0.5">Discover</span>
            </button>

            <button
              onClick={() => navigateTo('chat')}
              className={`flex flex-col items-center justify-center flex-1 py-1.5 relative ${
                currentScreen === 'chat' ? 'text-primary scale-105' : 'text-slate-400 hover:text-primary'
              }`}
            >
              <span className={`material-symbols-outlined text-[22px] ${currentScreen === 'chat' ? 'fill-icon' : ''}`}>chat_bubble</span>
              <span className="text-[9px] font-bold leading-none mt-0.5">Chat</span>
              {(() => {
                const totalUnreadCount = recentChats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
                return totalUnreadCount > 0 ? (
                  <span className="absolute top-1 right-6 bg-primary text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full min-w-4 text-center animate-pulse">
                    {totalUnreadCount}
                  </span>
                ) : null;
              })()}
            </button>

            <button
              onClick={() => navigateTo('notifications')}
              className={`flex flex-col items-center justify-center flex-1 py-1.5 relative ${
                currentScreen === 'notifications' ? 'text-primary scale-105' : 'text-slate-400 hover:text-primary'
              }`}
            >
              <span className={`material-symbols-outlined text-[22px] ${currentScreen === 'notifications' ? 'fill-icon' : ''}`}>notifications</span>
              <span className="text-[9px] font-bold leading-none mt-0.5">Alerts</span>
              {(() => {
                const count = notifications.filter(n => !n.read).length;
                return count > 0 ? (
                  <span className="absolute top-1 right-6 bg-primary text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full min-w-4 text-center">
                    {count}
                  </span>
                ) : null;
              })()}
            </button>

            <button
              onClick={() => navigateTo('edit_profile')}
              className={`flex flex-col items-center justify-center flex-1 py-1.5 ${
                currentScreen === 'edit_profile' ? 'text-primary scale-105' : 'text-slate-400 hover:text-primary'
              }`}
            >
              <span className={`material-symbols-outlined text-[22px] ${currentScreen === 'edit_profile' ? 'fill-icon' : ''}`}>person</span>
              <span className="text-[9px] font-bold leading-none mt-0.5">Profile</span>
            </button>
          </nav>
        )}

        {/* Story Privacy Selector Modal */}
        {showStoryPrivacyModal && (
          <div className="absolute inset-0 bg-[#0f172a]/85 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-fade-in">
            <div className="bg-white rounded-3xl p-6 text-center space-y-5 max-w-[320px] shadow-2xl border border-slate-100">
              <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-3xl">visibility</span>
              </div>
              
              <div className="space-y-1.5">
                <h3 className="font-title-md text-base font-extrabold text-[#111d23]">Story Privacy Setting</h3>
                <p className="text-xs text-slate-500 leading-relaxed">Choose who can view this story before posting.</p>
              </div>

              <div className="flex flex-col gap-3 pt-1">
                {/* Option 1: Everyone (Public) */}
                <button
                  onClick={() => postPendingStory('public')}
                  className="flex items-center gap-3 p-3 text-left rounded-2xl border border-slate-100 hover:border-primary/30 hover:bg-rose-50/20 transition-all cursor-pointer group"
                >
                  <div className="w-8 h-8 rounded-full bg-amber-50 flex items-center justify-center text-amber-500 group-hover:bg-amber-100/80 transition-colors">
                    <span className="material-symbols-outlined text-lg">public</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-bold text-slate-800 leading-tight">Everyone (Public)</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">Any user can view this, including guest explorer accounts.</p>
                  </div>
                </button>

                {/* Option 2: Followers only (Private) */}
                <button
                  onClick={() => postPendingStory('followers')}
                  className="flex items-center gap-3 p-3 text-left rounded-2xl border border-slate-100 hover:border-primary/30 hover:bg-rose-50/20 transition-all cursor-pointer group"
                >
                  <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-500 group-hover:bg-emerald-100/80 transition-colors">
                    <span className="material-symbols-outlined text-lg">group</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-bold text-slate-800 leading-tight">Followers Only</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">Only accepted mutual-follow connections can view this.</p>
                  </div>
                </button>
              </div>

              <div className="pt-2">
                <button
                  onClick={() => {
                    setPendingStoryBase64(null);
                    setShowStoryPrivacyModal(false);
                  }}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs uppercase transition-all active:scale-95"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

         {/* Guest Action Warning Modal */}
        {guestWarningModal && (
          <div className="absolute inset-0 bg-[#0f172a]/85 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-fade-in">
            <div className="bg-white rounded-3xl p-6 text-center space-y-5 max-w-[320px] shadow-2xl border border-rose-100/20">
              <div className="w-16 h-16 rounded-full bg-rose-50 flex items-center justify-center mx-auto text-primary">
                <span className="material-symbols-outlined text-3xl">block</span>
              </div>
              
              <div className="space-y-2">
                <h3 className="font-title-md text-base font-extrabold text-[#111d23]">
                  {guestWarningModal === 'profile' && 'Profile Creation Locked'}
                  {guestWarningModal === 'like' && 'Liking is Disabled'}
                  {guestWarningModal === 'message' && 'Messaging is Locked'}
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  {guestWarningModal === 'profile' && 'Guests cannot create, edit, or customize a profile. Please register to build your unique presence!'}
                  {guestWarningModal === 'like' && 'Guests can only explore. To like profiles, send Spark requests, or make matches, please register!'}
                  {guestWarningModal === 'message' && 'Guests cannot chat or send messages. Both users must follow each other to unlock chats!'}
                </p>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <button
                  onClick={() => {
                    setGuestWarningModal(null);
                    setIsGuest(false);
                    setCurrentScreen('welcome');
                  }}
                  className="w-full py-3 bg-primary text-white font-bold rounded-xl text-xs uppercase hover:brightness-110 transition-all active:scale-95 shadow-md"
                >
                  Sign In / Create Account
                </button>
                <button
                  onClick={() => setGuestWarningModal(null)}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs uppercase transition-all active:scale-95"
                >
                  Keep Exploring as Guest
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Sparks Profile Popup bottom-sheet / modal */}
        {sparkPopupProfile && (() => {
          const followingList = userProfile.following || [];
          const isFollowing = followingList.includes(sparkPopupProfile.id);
          const photos = sparkPopupProfile.photos && sparkPopupProfile.photos.length > 0
            ? sparkPopupProfile.photos
            : [sparkPopupProfile.photo || IMAGES.primaryOnboardingPic];

          return (
            <div className="fixed inset-0 bg-black/60 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in backdrop-blur-xs">
              <div
                className="bg-white w-full max-w-md rounded-t-[32px] sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-slide-up relative text-left"
                style={{ animationDuration: '300ms' }}
              >
                {/* Drag handle for bottom sheet effect */}
                <div className="w-12 h-1 bg-slate-200 rounded-full mx-auto my-3 shrink-0 block sm:hidden"></div>

                {/* Close Button on top right */}
                <button
                  onClick={() => setSparkPopupProfile(null)}
                  className="absolute right-4 top-4 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center z-30 transition-all active:scale-90"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>

                {/* Gallery */}
                <div className="relative w-full aspect-[4/3] bg-slate-100 shrink-0">
                  <img
                    src={photos[activePhotoIndex % photos.length]}
                    alt={sparkPopupProfile.name}
                    className="w-full h-full object-cover"
                  />
                  {photos.length > 1 && (
                    <>
                      {/* Swipe dots */}
                      <div className="absolute top-4 left-0 right-0 flex justify-center gap-1.5 z-20">
                        {photos.map((_, idx) => (
                          <span
                            key={idx}
                            className={`h-1 rounded-full transition-all duration-300 ${
                              idx === activePhotoIndex % photos.length
                                ? 'bg-primary w-4'
                                : 'bg-white/60 w-1.5'
                            }`}
                          ></span>
                        ))}
                      </div>
                      {/* Nav Arrows */}
                      <button
                        onClick={() => setActivePhotoIndex((prev) => (prev - 1 + photos.length) % photos.length)}
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 text-white backdrop-blur-md flex items-center justify-center active:scale-90 transition-all z-20 shadow-md"
                      >
                        <span className="material-symbols-outlined text-sm">chevron_left</span>
                      </button>
                      <button
                        onClick={() => setActivePhotoIndex((prev) => (prev + 1) % photos.length)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 text-white backdrop-blur-md flex items-center justify-center active:scale-90 transition-all z-20 shadow-md"
                      >
                        <span className="material-symbols-outlined text-sm">chevron_right</span>
                      </button>
                    </>
                  )}
                </div>

                {/* Bio & Details */}
                <div className="p-6 space-y-4 overflow-y-auto scrollbar-hide flex-1 text-left">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-title-md text-xl text-on-surface font-extrabold leading-none">
                          {sparkPopupProfile.name}, {sparkPopupProfile.age || 21}
                        </h3>
                        {sparkPopupProfile.isVerified && (
                          <span className="material-symbols-outlined text-[18px] text-primary fill-icon">verified</span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 font-bold mt-0.5">@{sparkPopupProfile.username || sparkPopupProfile.id}</p>
                    </div>
                    {sparkPopupProfile.sparkStatus && (
                      <span className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-600 text-[10px] font-extrabold tracking-wider uppercase border border-rose-100/30 shadow-2xs">
                        Spark connection
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-slate-600 leading-relaxed">
                    {sparkPopupProfile.bio || 'Mindful aura member sharing pure vibrations.'}
                  </p>

                  {/* Actions Row */}
                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={() => {
                        if (isGuest) {
                          setGuestWarningModal('like');
                          return;
                        }
                        toggleFollowUser(sparkPopupProfile.id);
                        if (!isFollowing) {
                          setSparkPopupProfile(null);
                          navigateTo('spark_match');
                        }
                      }}
                      className={`flex-1 h-11 rounded-xl text-xs font-extrabold uppercase tracking-widest transition-all flex items-center justify-center gap-2 cursor-pointer border ${
                        isFollowing
                          ? 'bg-slate-100 border-slate-200 text-slate-700'
                          : 'bg-primary border-primary text-white hover:brightness-110 shadow-md'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">
                        {isFollowing ? 'check' : 'favorite'}
                      </span>
                      <span>{isFollowing ? 'Following' : 'Follow'}</span>
                    </button>

                    <button
                      onClick={() => {
                        if (isGuest) {
                          setGuestWarningModal('message');
                          return;
                        }
                        setSelectedChatPartner(sparkPopupProfile);
                        setSparkPopupProfile(null);
                        navigateTo('chat');
                      }}
                      className="flex-1 h-11 bg-white border border-slate-200 rounded-xl text-xs font-extrabold uppercase tracking-widest text-slate-700 hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95 shadow-2xs"
                    >
                      <span className="material-symbols-outlined text-sm">chat</span>
                      <span>Message</span>
                    </button>
                  </div>

                  {/* View Full Profile Button */}
                  <button
                    onClick={() => {
                      setSparkPopupProfile(null);
                      openUserProfile(sparkPopupProfile.id);
                    }}
                    className="w-full py-3 border border-slate-100 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-extrabold uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-2xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-base">person</span>
                    <span>View Full Profile</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Followers / Following List Modal popup */}
        {followListType && (
          <div className="fixed inset-0 bg-black/60 z-[110] flex items-center justify-center p-6 animate-fade-in backdrop-blur-xs">
            <div className="bg-white w-full max-w-sm rounded-3xl shadow-2xl flex flex-col max-h-[480px] overflow-hidden border border-slate-100 animate-slide-up" style={{ animationDuration: '250ms' }}>
              {/* Header */}
              <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <h3 className="font-title-md text-sm font-extrabold text-[#111d23] capitalize">
                  {followListUserName} {followListType}
                </h3>
                <button
                  onClick={() => {
                    setFollowListType(null);
                    setFollowListUsers([]);
                  }}
                  className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center active:scale-90 transition-all cursor-pointer"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>

              {/* Scrollable List */}
              <div className="flex-1 overflow-y-auto p-4 scrollbar-hide space-y-3">
                {followListLoading ? (
                  /* Loading Skeletons */
                  <div className="space-y-3">
                    {[1, 2, 3].map((n) => (
                      <div key={n} className="flex items-center gap-3 animate-pulse py-1">
                        <div className="w-10 h-10 rounded-full bg-slate-100"></div>
                        <div className="flex-1 space-y-2">
                          <div className="h-3 bg-slate-100 rounded w-1/2"></div>
                          <div className="h-2 bg-slate-100 rounded w-1/3"></div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : followListUsers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-slate-400 space-y-2">
                    <span className="material-symbols-outlined text-3xl">group</span>
                    <p className="text-xs font-semibold">No {followListType} found</p>
                  </div>
                ) : (
                  followListUsers.map((user) => {
                    const isFollowingUser = userProfile.following?.includes(user.uid);
                    return (
                      <div
                        key={user.uid}
                        onClick={() => {
                          setFollowListType(null);
                          openUserProfile(user.uid);
                        }}
                        className="flex items-center justify-between p-2 rounded-2xl border border-slate-50 hover:bg-slate-50 cursor-pointer transition-all active:scale-99 text-left"
                      >
                        <div className="flex items-center gap-3">
                          <img
                            src={user.photo || IMAGES.primaryOnboardingPic}
                            alt={user.name}
                            className="w-10 h-10 rounded-full object-cover border border-slate-100"
                          />
                          <div className="flex flex-col">
                            <span className="text-xs font-extrabold text-slate-800 leading-tight flex items-center gap-1">
                              {user.name}
                              {user.isVerified && (
                                <span className="material-symbols-outlined text-[13px] text-primary fill-icon">verified</span>
                              )}
                            </span>
                            <span className="text-[10px] text-slate-400">@{user.username || user.uid}</span>
                          </div>
                        </div>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFollowUser(user.uid);
                          }}
                          className={`px-3 py-1.5 rounded-xl text-[9px] font-extrabold uppercase tracking-wider transition-all cursor-pointer ${
                            isFollowingUser
                              ? 'bg-slate-100 text-slate-600 border border-slate-200'
                              : 'bg-primary text-white hover:brightness-110 shadow-sm'
                          }`}
                        >
                          {isFollowingUser ? 'Following' : 'Follow'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* Global Story Fullscreen Overlay */}
        {activeStoryIndex !== null && storyViewerList[activeStoryIndex] && (() => {
          const story = storyViewerList[activeStoryIndex];
          const isOwnStory = story.userUid === auth.currentUser?.uid || story.id.toString().startsWith('user_story_') || story.id === 'julian';

          return (
            <div className="fixed inset-0 bg-black/95 z-[10000] flex flex-col justify-between py-6 px-4 animate-fade-in text-white">
              {/* Top Timer Bar & Header */}
              <div className="w-full flex flex-col gap-3">
                <div className="flex gap-1.5 w-full">
                  {storyViewerList.map((_, idx) => {
                    let widthPercent = 0;
                    if (idx < activeStoryIndex) widthPercent = 100;
                    else if (idx === activeStoryIndex) widthPercent = activeStoryTimeLeft;
                    return (
                      <div key={idx} className="flex-1 h-1 bg-white/30 rounded-full overflow-hidden">
                        <div className="bg-white h-full transition-all ease-linear" style={{ width: `${widthPercent}%` }}></div>
                      </div>
                    );
                  })}
                </div>

                {/* Story Header */}
                <div className="flex items-center justify-between text-white">
                  <button
                    onClick={() => {
                      setActiveStoryIndex(null);
                      if (story.userUid) {
                        openUserProfile(story.userUid);
                      }
                    }}
                    className="flex items-center gap-2 hover:bg-white/10 p-1.5 rounded-xl transition-all cursor-pointer"
                  >
                    <div className="w-8 h-8 rounded-full border border-white overflow-hidden bg-slate-100">
                      <img src={story.photo} alt={story.name} className="w-full h-full object-cover" />
                    </div>
                    <span className="text-xs font-bold">{story.name}</span>
                  </button>
                  <div className="flex items-center gap-2">
                    {/* Add more stories option inside own story view */}
                    {isOwnStory && (
                      <button
                        onClick={() => {
                          setActiveStoryIndex(null);
                          storyFileInputRef.current?.click();
                        }}
                        className="text-white hover:text-primary p-1 bg-white/10 hover:bg-white/20 rounded-lg transition-all flex items-center gap-1 text-[10px] font-bold px-2 py-1"
                        title="Add another story"
                      >
                        <span className="material-symbols-outlined text-[14px]">add_circle</span>
                        <span>Add Story</span>
                      </button>
                    )}
                    {/* Delete option for own stories */}
                    {isOwnStory && story.dbId && (
                      <button
                        onClick={async () => {
                          if (confirm("Are you sure you want to delete this story?")) {
                            try {
                              const res = await fetchFromBackend(`/api/stories/${story.dbId}`, {
                                method: 'DELETE',
                              });
                              if (res.ok) {
                                showToast('Story deleted successfully', 'success');
                                setActiveStoryIndex(null);
                                // Refresh stories
                                fetchDbStories();
                              } else {
                                showToast('Failed to delete story.', 'error');
                              }
                            } catch (err) {
                              console.error(err);
                              showToast('Failed to delete story.', 'error');
                            }
                          }
                        }}
                        className="text-white hover:text-red-500 p-1 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                        title="Delete story"
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    )}
                    <button onClick={() => setActiveStoryIndex(null)} className="text-white hover:text-primary p-1 bg-white/10 hover:bg-white/20 rounded-lg transition-colors">
                      <span className="material-symbols-outlined text-[20px]">close</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Top Banner Ad */}
              <div className="bg-gradient-to-r from-purple-900/80 to-indigo-950/80 border border-purple-500/30 rounded-xl p-2.5 text-center text-[10px] font-medium text-purple-200 shadow-sm animate-pulse flex items-center justify-center gap-1.5 select-none">
                <span className="material-symbols-outlined text-[12px] text-amber-400">workspace_premium</span>
                <span>SPONSORED: Spark more profiles with Aura Premium for 5x match rates!</span>
              </div>

              {/* Story Main Image */}
              <div className="flex-1 flex items-center justify-center my-4 overflow-hidden rounded-2xl">
                <img
                  src={story.photo}
                  className="w-full max-h-[50vh] object-contain rounded-2xl shadow-xl"
                  alt="story full view"
                />
              </div>

              {/* Bottom Banner Ad */}
              <div className="bg-gradient-to-r from-rose-950/80 to-slate-900/80 border border-rose-500/30 rounded-xl p-2.5 text-center text-[10px] font-medium text-rose-200 shadow-sm flex items-center justify-center gap-1.5 select-none">
                <span className="material-symbols-outlined text-[12px] text-rose-400">ads_click</span>
                <span>AD: Try Aura Gold standard today to boost profile views by 400%!</span>
              </div>

              {/* Story views and viewers list (for story owners only) */}
              {isOwnStory && (
                <div className="bg-slate-900/85 border border-slate-800 rounded-2xl p-3.5 space-y-2 mt-2 w-full text-left">
                  <div className="flex justify-between items-center text-xs font-bold text-slate-300">
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm text-primary">visibility</span>
                      <span>Story Views</span>
                    </span>
                    <span className="bg-primary px-2.5 py-0.5 rounded-full text-white text-[10px]">
                      {story.viewCount || 0} {story.viewCount === 1 ? 'view' : 'views'}
                    </span>
                  </div>
                  {story.viewers && story.viewers.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 pt-1 max-h-[72px] overflow-y-auto scrollbar-hide">
                      {story.viewers.map((v: any) => (
                        <div key={v.uid} className="flex items-center gap-1.5 bg-white/10 hover:bg-white/15 px-2 py-1 rounded-full text-[10px] text-slate-200 transition-colors">
                          <img src={v.photo || IMAGES.coupleBackground} alt={v.name} className="w-4 h-4 rounded-full object-cover border border-white/20" />
                          <span>{v.name}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-slate-500 italic">No views yet. Share this story with friends!</p>
                  )}
                </div>
              )}

              {/* Story footer chat shortcut */}
              <div className="flex gap-2 items-center mt-2">
                <input
                  type="text"
                  placeholder={`Reply to ${story.name}...`}
                  className="flex-1 bg-white/10 text-white placeholder:text-white/60 border border-white/20 rounded-full py-2 px-4 text-xs outline-none focus:bg-white/20 focus:border-white text-left"
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter') {
                      const textVal = (e.target as HTMLInputElement).value.trim();
                      if (!textVal) return;
                      try {
                        const replyMsg = `Replied to your story: ${textVal}`;
                        await fetchFromBackend('/api/messages', {
                          method: 'POST',
                          body: JSON.stringify({
                            receiverUid: story.userUid,
                            text: replyMsg,
                            timeString: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                          }),
                        });
                        showToast(`Message reply sent to ${story.name}!`, "success");
                        (e.target as HTMLInputElement).value = '';
                        setActiveStoryIndex(null);
                      } catch (err) {
                        console.error("Failed to send story reply:", err);
                        showToast("Failed to send reply", "error");
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const myName = userProfile.name || 'Someone';
                      await fetchFromBackend('/api/notifications', {
                        method: 'POST',
                        body: JSON.stringify({
                          receiverUid: story.userUid,
                          type: 'system',
                          text: `${myName} liked your story`,
                        }),
                      });
                      showToast(`Liked ${story.name}'s story!`, "success");
                    } catch (err) {
                      console.error("Failed to like story:", err);
                    }
                  }}
                  className="text-white hover:text-[#b80049] transition-colors focus:outline-none cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[20px] active:scale-125 transition-transform">favorite</span>
                </button>
              </div>
            </div>
          );
        })()}

        {/* Ad Simulation Overlay */}
        {watchingAd && (
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md z-[1000] flex flex-col items-center justify-center text-white p-6 animate-fade-in text-center">
            <div className="relative w-72 bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-6 shadow-2xl flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center animate-bounce">
                <span className="material-symbols-outlined text-4xl">play_circle</span>
              </div>
              <div className="space-y-1">
                <h3 className="font-title-md text-base font-bold text-white">Sponsor Advertisement</h3>
                <p className="text-[11px] text-slate-400">Please watch the ad to claim your reward...</p>
              </div>
              
              {/* Simulated Video Player Box */}
              <div className="w-full aspect-video bg-black rounded-2xl flex flex-col items-center justify-center border border-slate-800 relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-tr from-rose-500/10 to-primary/10 animate-pulse"></div>
                <span className="material-symbols-outlined text-3xl text-slate-700 animate-spin">sync</span>
                <span className="text-[10px] text-slate-400 mt-2 font-mono">Simulating video playback...</span>
              </div>

              <div className="w-full space-y-2">
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div 
                    className="bg-amber-500 h-full transition-all duration-1000 ease-linear" 
                    style={{ width: `${((2 - adTimeLeft) / 2) * 100}%` }}
                  ></div>
                </div>
                <div className="flex justify-between text-[10px] text-slate-400 font-bold font-mono">
                  <span>Reward in:</span>
                  <span>{adTimeLeft}s</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Dynamic Float Toast Notification */}
        {toast && (
          <div className="absolute top-4 left-4 right-4 z-[99999] pointer-events-none animate-slide-down">
            <div className={`mx-auto max-w-[340px] rounded-2xl px-4 py-3 shadow-2xl border flex items-center gap-3 backdrop-blur-md text-white ${
              toast.type === 'success'
                ? 'bg-emerald-600/95 border-emerald-500/30'
                : toast.type === 'error'
                  ? 'bg-rose-600/95 border-rose-500/30'
                  : 'bg-slate-900/95 border-slate-800'
            }`}>
              <span className="material-symbols-outlined text-lg">
                {toast.type === 'success' && 'check_circle'}
                {toast.type === 'error' && 'error'}
                {toast.type === 'info' && 'info'}
              </span>
              <p className="text-xs font-bold leading-tight flex-1 text-left">{toast.message}</p>
            </div>
          </div>
        )}

        {/* Public Profile QR Code Modal */}
        {showQrModal && (
          <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-[99999] flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-white rounded-3xl p-6 w-full max-w-[320px] text-center space-y-4 shadow-2xl border border-slate-100">
              <div className="flex justify-between items-center pb-2 border-b border-slate-100">
                <h3 className="font-title-md text-sm font-extrabold text-[#111d23]">Your Public QR Code</h3>
                <button
                  onClick={() => setShowQrModal(false)}
                  className="text-slate-400 hover:text-slate-600 active:scale-90 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <p className="text-[10px] text-slate-400">
                Scan this code with a mobile camera to open your public profile directly on Aura.
              </p>
              <div className="mx-auto w-48 h-48 bg-slate-50 rounded-2xl flex items-center justify-center border border-slate-100 p-2">
                <img
                  src={qrUrl}
                  alt="Aura Public Profile QR Code"
                  className="w-full h-full object-contain rounded-xl"
                  referrerPolicy="no-referrer"
                />
              </div>
              <button
                onClick={() => setShowQrModal(false)}
                className="w-full py-2.5 bg-primary text-white font-bold rounded-xl text-xs uppercase hover:brightness-110 transition-all active:scale-95 cursor-pointer"
              >
                Close Dialog
              </button>
            </div>
          </div>
        )}

        {/* Full-Screen Photo Viewer Modal */}
        {fullScreenImage && (() => {
          const targetUser = selectedDiscoverPerson || discoverPeople[activeDiscoverIndex % discoverPeople.length] || AVAILABLE_PEOPLE[0];
          const photos = targetUser.photos || [targetUser.photo || IMAGES.coupleBackground];
          const currentIndex = photos.indexOf(fullScreenImage) !== -1 ? photos.indexOf(fullScreenImage) : 0;
          
          return (
            <div className="fixed inset-0 bg-black z-[99998] flex flex-col justify-between select-none animate-fade-in">
              {/* Header */}
              <header className="flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent text-white z-20">
                <button
                  onClick={() => {
                    setFullScreenImage(null);
                  }}
                  className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white active:scale-90 transition-all"
                >
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
                <div className="text-center">
                  <span className="text-xs font-bold tracking-widest uppercase text-white">Viewer</span>
                  <p className="text-[10px] text-slate-400 font-bold">{currentIndex + 1} / {photos.length}</p>
                </div>
                <a
                  href={fullScreenImage}
                  target="_blank"
                  rel="noreferrer"
                  download={`aura-${targetUser.name}-${currentIndex + 1}.jpg`}
                  className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white active:scale-90 transition-all"
                  title="Download Image"
                >
                  <span className="material-symbols-outlined text-[20px]">download</span>
                </a>
              </header>

              {/* Central Image with Navigation */}
              <div className="flex-1 flex items-center justify-center relative overflow-hidden px-4">
                <button 
                  onClick={() => {
                    const prevIdx = (currentIndex - 1 + photos.length) % photos.length;
                    setFullScreenImage(photos[prevIdx]);
                  }}
                  className="absolute left-4 w-12 h-12 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center z-10 active:scale-90 transition-all"
                >
                  <span className="material-symbols-outlined text-lg font-bold">arrow_back_ios</span>
                </button>

                <img
                  src={fullScreenImage}
                  className="max-w-full max-h-[75vh] object-contain rounded-lg transition-transform duration-300 shadow-2xl"
                  alt="Full-screen portrait"
                  referrerPolicy="no-referrer"
                />

                <button 
                  onClick={() => {
                    const nextIdx = (currentIndex + 1) % photos.length;
                    setFullScreenImage(photos[nextIdx]);
                  }}
                  className="absolute right-4 w-12 h-12 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center z-10 active:scale-90 transition-all"
                >
                  <span className="material-symbols-outlined text-lg font-bold">arrow_forward_ios</span>
                </button>
              </div>

              {/* Footer controls */}
              <footer className="p-6 bg-gradient-to-t from-black/80 to-transparent text-white flex justify-center items-center gap-6 z-20">
                <button
                  onClick={() => {
                    const prevIdx = (currentIndex - 1 + photos.length) % photos.length;
                    setFullScreenImage(photos[prevIdx]);
                  }}
                  className="flex flex-col items-center gap-1 opacity-85 hover:opacity-100 active:scale-90"
                >
                  <span className="material-symbols-outlined text-lg">chevron_left</span>
                  <span className="text-[9px] font-bold">PREV</span>
                </button>
                <div className="h-6 w-[1px] bg-white/20"></div>
                <button
                  onClick={() => {
                    window.open(fullScreenImage, '_blank');
                  }}
                  className="flex flex-col items-center gap-1 opacity-85 hover:opacity-100 active:scale-90"
                >
                  <span className="material-symbols-outlined text-lg">open_in_new</span>
                  <span className="text-[9px] font-bold">ORIGINAL</span>
                </button>
                <div className="h-6 w-[1px] bg-white/20"></div>
                <button
                  onClick={() => {
                    const nextIdx = (currentIndex + 1) % photos.length;
                    setFullScreenImage(photos[nextIdx]);
                  }}
                  className="flex flex-col items-center gap-1 opacity-85 hover:opacity-100 active:scale-90"
                >
                  <span className="material-symbols-outlined text-lg">chevron_right</span>
                  <span className="text-[9px] font-bold">NEXT</span>
                </button>
              </footer>
            </div>
          );
        })()}

        {/* Custom Confirmation / Alert Modal Dialog */}
        {confirmModal && (
          <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-[99999] flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-white rounded-3xl p-6 w-full max-w-[320px] text-center space-y-4 shadow-2xl border border-slate-100">
              <div className="flex justify-between items-center pb-2 border-b border-slate-100">
                <h3 className="font-title-md text-sm font-extrabold text-[#111d23]">{confirmModal.title}</h3>
                <button
                  onClick={() => setConfirmModal(null)}
                  className="text-slate-400 hover:text-slate-600 active:scale-90 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed text-left">
                {confirmModal.message}
              </p>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setConfirmModal(null)}
                  className="flex-1 py-2.5 border border-slate-200 text-slate-600 font-bold rounded-xl text-[10px] uppercase hover:bg-slate-50 transition-all active:scale-95 cursor-pointer"
                >
                  {confirmModal.cancelText || 'Cancel'}
                </button>
                <button
                  onClick={() => {
                    confirmModal.onConfirm();
                    setConfirmModal(null);
                  }}
                  className="flex-1 py-2.5 bg-primary text-white font-bold rounded-xl text-[10px] uppercase hover:brightness-110 transition-all active:scale-95 cursor-pointer"
                >
                  {confirmModal.confirmText || 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Background Privacy Shield Overlay */}
        {isBlurred && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-2xl z-[100000] flex flex-col items-center justify-center p-6 text-center select-none pointer-events-none animate-fade-in">
            <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-4xl">security</span>
            </div>
            <h2 className="font-title-md text-base font-extrabold text-[#111d23] mb-1">Aura Privacy Shield</h2>
            <p className="text-xs text-slate-500 max-w-[240px] leading-relaxed">
              Screen content is hidden to protect your secure dating information.
            </p>
          </div>
        )}
    </div>
  );
}
