export type Screen =
  | 'welcome'
  | 'signin'
  | 'onboarding_basics'
  | 'onboarding_interests'
  | 'onboarding_photos'
  | 'location_access'
  | 'discover'
  | 'profile_details'
  | 'spark_match'
  | 'chat'
  | 'stories'
  | 'aura_gold'
  | 'creator_monetization'
  | 'edit_profile'
  | 'notifications';

export interface AppNotification {
  id: string | number;
  type: 'follow' | 'follow_accepted' | 'system';
  title: string;
  message: string;
  senderId: string;
  senderName: string;
  senderPhoto: string;
  senderUsername: string;
  read: boolean;
  createdAt: string;
  canFollowBack?: boolean;
  followStatus?: 'pending' | 'accepted' | null;
}

export interface UserProfile {
  name: string;
  age: number;
  dob: { dd: string; mm: string; yyyy: string };
  gender: string;
  interests: string[];
  photos: string[];
  location: string;
  profession: string;
  bio: string;
  username?: string;
  following?: string[];
  followers?: string[];
  role?: string;
}

export interface Message {
  id: string | number;
  sender: 'user' | string;
  text?: string;
  image?: string;
  time: string;
  isRead?: boolean;
  createdAt?: string;
}

export interface Story {
  id: string | number;
  dbId?: number;
  userUid?: string;
  name: string;
  photo: string;
  active: boolean;
  createdAt?: string;
  viewCount?: number;
  viewers?: { uid: string; name: string; photo: string; username?: string }[];
  visibility?: 'public' | 'followers';
}

export interface SparkRequest {
  id: string;
  name: string;
  photo: string;
  status: 'pending' | 'accepted' | 'declined';
}

export interface Suggestion {
  id: string;
  name: string;
  age: number;
  location: string;
  photo: string;
  interests: string[];
  type: 'bolt' | 'magic';
}
