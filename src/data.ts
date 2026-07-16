import { Story, SparkRequest, Suggestion, Message, UserProfile } from './types';

export const IMAGES = {
  coupleBackground: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDKDCnp5eF81EBF13qSlHG31wDQ-bGI8xQqve2O_d7gv6sUNGNGyohYnmPQv_KYu3EQNnkvjUi6hk-AeUTiy7T1MDV_NZg2YCBLGSUqgdt3wnQRDI9xGRbStcwddt6JVCHJIAve7Y6qzxtAV5eyEkQ5MfsfiQRZow--0f21rwJT0oUVB_wJQBJ2RgyRlJozfDiz_QXpKuB45aIZimxg2QtkLn4SnwmyX5WJfM-GVCnrmLimsYo4Bt1p',
  auraLogo: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCATqBA9S3uGFQ2dHu7RaelrBEJ8mjG8XcmiXjzUeBJ7qZ7tXjQ3TE7G5c_8_IwZmtrarF1R1rvD7VTE-syERDsZw6Z8D-t2KvRMsWkMtqhp2xJuk8BjurylC9FxYwbe_4uW0gRNGHZnCxANS5ZRA7xoPHwxiPQh7iGy2X3TPNsC3aFDGmDptqRGpM3lEF5pVhHMtgfp1NL0LzMS8Y6X0ij1VYSLGVgloG7aIUdfip3vSGyZKRXEOsc',
  elenaSwipe: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBHKDDnsHXB-mH_5lESkKa0PfAdyvSNhzL3T_jusVtlyUVgspR_NOkmNzf3dHtM3x0GBdMZSmOGXIFotv0FvqhbjZ88DKHos4Ei71U0l_qmPRNgLX0ANPRLMbD70tHgJpyxoBE8s1sFU6R2MAb9E0IW3dE-BlmJiVeRiVSSgZlO9x66rVhgfGa7EOzRep19nNqsGCr5jVB8b_hQwrtysh3iatGgVSejl6uu9_twbGtzojNoMRO5WBhg',
  userMatchLeft: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDj6bKRnpqd2yLJ-3rov5eiigHEuTcDtwkr-WvHrIDZqHp1CGH9CL_j9Octa-zINt8LWKGVRFgOGexR55hrPDVJEHfe85DG8SRyNLkhcaAY32UesqgcWm2LulV0QWLI_lOQS_5tt7fGzXAAl-DvObNWQlsmJTM_ahW4Jz6H6a602JzmVp6bIYVOm0tVohwsr4YZdT3vKjnxkSlaKSdClNPI_smdv8WP41CHXO0icoXLFzhbvX7Afin-',
  elenaMatchRight: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBcatpytq4SV_2OgRw1FWpHlgfhpvAP9uY37muUYb5th4kgVkW-ceDAVvS6bgmMM_kCToXo0vaj_a-5c4QICJlaCfA-I61Y1-ugkt4PmAHKRsVw6qRvVNTgVCMAlabMePBhV237kGHJ0rGLqMKHMAPEvR_HswPwDUSZ4Fz-5Dgbt8V4wgyMPH72SgF-bN88dGjsqBn-X49hjvb5YWBgem5FAO6lH-sIt3ssH72RLrTXSb6zknud93cP',
  elenaChatAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDTEcb525i5H_9hYXC6PieFh41_m9NXm7cJ3hDkx8D4hS4w3HPDYtaNJOcJCbeQHC61mpHNUqLk67Z95Ipgh6De3GV436TCpXzPS4PsGUuBx5QKkb8I7PgbKRs_ABpyLvOjumh_1aFd9cf03T6g-gGeE5p6voRvsk375AqdT2wCFkCCkge3Ut3kXh4fQC01CG1JGcC-p_BL177toz6O2bFcHIE2ydpSrhYHwtcGkUzrTWhQpvEgDT3h',
  facadeChatImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBNCV8nYTLl1Znove71X329Ir6jLlVQ6fsoQVM72KD4qPeTSSM6FUb0xZyU4T-O9DdjRA7qIJt0xMpfE6Cb4bu1SSywAoNH-qZcoj97aVU7zp2Hi8YZxKACzeJbRTvW0OsNgVp_3eRJ1EiunGp19xb2Ydu3k1V_38PG0gdmkHBP5VX0fRk1HX06X5MQLfU6XiQIKe6WNcTXBOrNO18J_KP64Uj4xp0xNHVX6Z_GZkAjzsWBV8f0750B',
  elenaGallery1: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDK5PoJDm3gVYt944KYNmu1jZuicTKKUEhx3ngeqWQNQBEAlYn19C4OTteoGIDsuEbTgTmrOtduW2qlJ0dG2az7aGZw9e6-ycTnDrJa2zRigF7qpWZKRsrVgbw__LDtIxpOItK1cujgjWDSIzqi527ENt7LsCht_v5lUXS83ZjzVvaWrrQ4dDlOuehZ7agML8uG-0iLLOCrWFZRUCyBlHndRP6xFmHa1A94ORBFv66AF5wldjGWLZHe',
  elenaGallery2: 'https://lh3.googleusercontent.com/aida-public/AB6AXuD5dxzZgJ7CpNwLZQHQ3LdANBbtJjXmsRX2Y8vpIL4Za0o0XrSYzhFvS1km4vXfZTOUQs30E3e3_C5mj4IuPsNP6j73KUnWceEIbvtplg4BzljN_e-pe6vE7buFO0BEYU6K4fgN8wvPH1DxPqt6LQVRhSTbupoMnyz4ivIi0W3HsuZWvn_yfVbGU5RBjUmimHs4JTfMd1iK1qnc5mfR4lvYYc0l-vRaX-mSKEQFo3pnOB5tESo6Clwj',
  elenaGallery3: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDM4z0nR5cBSX9mToTVi-JC0ai_G9loLEZZmyf6UbIikSB7_Ya5xuoZi9vkbBVohjTMciOWCgw5DmqCZ8Oqyz6oPrsKsgc14c8VN_vbJHX2hTZ7HzbnVcwSu_E0x2-2W_t1fckv9ksr19jMEOOY_DQi2oBVZj1ibtaF5SoxUj-0d4cTU0R4ju_nATVzH0BeX7bGLYqnvevziVkNLky-1HQhXBRbjP7fefyxuar8W8xPabeMD_0FVHVO',
  primaryOnboardingPic: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBYFJbnvJ_JMCH-u7ZhNpi4VmzPez1D_AWapQ_82Xzajfr6QzW1lk6zPIH8bwbPe67qAkg6amq4TtaY2fSuRY0HO_SNCHiIJ853_N7TFKeDrZK-KJA27Xg4L8CwG_hiEuqK21uTPBikM4n9mODilGdvhx_5mY9x94_-IxKKGwvAd1qfpVz-amWyVXxQPEuuvxM15Fywci8MJsZkiYW7Vjh9D0ogDpKbABa0jvFVQ3IKBFeLckQe-y9y',
  mapBackground: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBJ01ioWGVgjEK05Af6l0v3ax9b1-k27aHYCy9y1r0FD_FMynMxZpsPMImBzoOvisb0I_Jq06aRyiZ1M2bPJoobNURgWaJF-7Td1Knu2PgdTsy8cPAF4jvmUGQyC9St4Ey52-btjFZX6Ba19eDnCvUErTg3TfuHQ46XZGsIT-cMkgi6DQw9xUQy_PJz8eX2WwFz63Oqe9eAdT3jI1xC5q1KCQTdBf7uDbp8b7bOVTUrV6uMdMfj82oT',
  coupleCafeBg: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBKDiSkcHjhekRyMEXHpJfpWADpoBi95FMjuvXidmyVg1z38o4vmS_dV0Oltb4MfRz2zt5P7hH7fSfnnf3KrQgq2qu6KHSCl9Is9tJIa9Y8PWoZ-to_QVbeVExG5pmFdXucE10he7LELhYhX_lbhe67IR8DE3DrGYgwEDr9cn5wUUGb-qZ3JGAA46ZwrMaNXk6qEuVGORLdfmDXyqafOhrfKmndQSj7RuUVuLkdK8PpmZ5PY6-MJRwU',
  auraLogoAlt: 'https://lh3.googleusercontent.com/aida/AP1WRLsO0b_dBW1Ob1gBhn09WKQhMf0XS5TctYT_JM9_K5Ogz9j0_gBT5Zp8yv7QL77Xzkceb7C9b7nyrOn-bTt6p78YIyCUDGRvp5k_zWAeCYydoZECf52zqJ7-1yfmly6nFfrGuG_m-Xa0LelRHQbNJxzbR6w9RovtZa9IkAYa6ktkZRE_cWXmxLgnKVwDmOLVIjw-EEwdBaOViY5l53867fgZXrNuSLAwNi0bVJs_aVTZZ_5nd_48O1-uXtM',
  julianEditPhoto: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAR4cXJvZZxcohLfMMUjm3sY0jA3dDRCfDuXWDe4gbTXUa9i_iTXAUC8KiU9wtrT47kKtcL9XBlUaZXLX5Oc-8UrmvfvP0yieD0ZtDblHYA-gUWZCNz8s3MzCOe4duyGVvWyQNqjzORxaq6Do_F61jHkoeDFt62U-0v0Ih6I_4b4dy8BFMzXu6w2qo-fodpPmTxvr1md_fqGY4o8-5EhnUlYAUGsmx0HFTnbvv5ZYgc87TboCzCr35S',
};

export const INITIAL_USER: UserProfile = {
  name: 'Julian',
  age: 28,
  dob: { dd: '14', mm: '08', yyyy: '1997' },
  gender: 'Man',
  interests: ['Architecture', 'Pottery', 'Hiking', 'Jazz'],
  photos: [IMAGES.julianEditPhoto],
  location: 'London, UK',
  profession: 'Architectural Designer',
  bio: 'Architectural designer with a love for brutalist geometry and quiet Sunday mornings. Seeking someone who appreciates the nuance in the everyday.',
  username: 'julian',
  following: [],
  followers: []
};

export const STORIES: Story[] = [];

export const SPARKS: SparkRequest[] = [];

export const SUGGESTIONS: Suggestion[] = [];

export const INITIAL_CHAT: Message[] = [
  {
    id: '1',
    sender: 'elena',
    text: 'I was just thinking about that gallery we visited. The lighting there reminded me of your photography style. 🎨',
    time: '10:14 AM',
    isRead: true,
  },
  {
    id: '2',
    sender: 'user',
    text: 'That means a lot! I actually just finished editing some new shots from this morning. Want to see one?',
    time: '10:16 AM',
    isRead: true,
  },
  {
    id: '3',
    sender: 'elena',
    text: "I'd love to. You always have such a unique perspective on the city. Please send it over! ✨",
    time: '10:17 AM',
    isRead: true,
  },
  {
    id: '4',
    sender: 'user',
    image: IMAGES.facadeChatImage,
    text: 'Caught the light just as it hit the facade.',
    time: '10:18 AM',
    isRead: true,
  },
];

export const INTERESTS_OPTIONS = [
  { name: 'Art', icon: 'palette' },
  { name: 'Travel', icon: 'flight' },
  { name: 'Jazz', icon: 'piano' },
  { name: 'Wine Tasting', icon: 'wine_bar' },
  { name: 'Architecture', icon: 'apartment' },
  { name: 'Fine Dining', icon: 'restaurant' },
  { name: 'Wellness', icon: 'fitness_center' },
  { name: 'Nature', icon: 'local_florist' },
  { name: 'Photography', icon: 'camera' },
  { name: 'Literature', icon: 'menu_book' },
  { name: 'Yoga', icon: 'self_improvement' },
  { name: 'Opera', icon: 'theater_comedy' },
  { name: 'Sailing', icon: 'sailing' },
  { name: 'Museums', icon: 'history_edu' },
  { name: 'Philosophy', icon: 'psychology' },
];
