import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { db } from "./src/db/index.ts";
import { users, swipes, dbMessages, userTracking, stories, blocks, reports, storyViews, follows, dbNotifications } from "./src/db/schema.ts";
import { eq, and, or, desc, like, ilike, ne, inArray, notInArray, gt, lt } from "drizzle-orm";
import { requireAuth, optionalAuth, AuthRequest } from "./src/middleware/auth.ts";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

// Helper to calculate distance between two coordinates in km using the Haversine formula
function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Initialize Gemini AI client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: true }));

  // API Routes

  // 1. Get or Create User Profile
  app.get("/api/users/profile", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const userList = await db.select().from(users).where(eq(users.uid, uid));
      
      if (userList.length === 0) {
        // Return 404 to indicate client should onboard
        return res.status(404).json({ message: "Profile not found. Onboarding required." });
      }
      
      res.json(userList[0]);
    } catch (error: any) {
      console.error("Failed to fetch user profile from Postgres:", error);
      res.status(500).json({ error: "Failed to fetch user profile" });
    }
  });

  app.post("/api/users/profile", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { email, name, username, photo, photos, bio, age, gender, interests, latitude, longitude } = req.body;

      // Check existing user to preserve role, isSubscribed, isVerified securely
      const existing = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
      const isNew = existing.length === 0;

      const finalRole = isNew ? 'user' : existing[0].role;
      const finalSubscribed = isNew ? false : existing[0].isSubscribed;
      const finalVerified = isNew ? false : existing[0].isVerified;

      const result = await db.insert(users)
        .values({
          uid,
          email: email || req.user.email || "",
          name: name || null,
          username: username || null,
          photo: photo || null,
          photos: photos ? (typeof photos === 'string' ? photos : JSON.stringify(photos)) : null,
          bio: bio || null,
          age: typeof age === 'number' ? age : null,
          gender: gender || null,
          interests: interests || null,
          role: finalRole,
          isSubscribed: finalSubscribed,
          isVerified: finalVerified,
          latitude: latitude || (existing[0] ? existing[0].latitude : null),
          longitude: longitude || (existing[0] ? existing[0].longitude : null),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: users.uid,
          set: {
            email: email || req.user.email || "",
            name: name || null,
            username: username || null,
            photo: photo || null,
            photos: photos ? (typeof photos === 'string' ? photos : JSON.stringify(photos)) : null,
            bio: bio || null,
            age: typeof age === 'number' ? age : null,
            gender: gender || null,
            interests: interests || null,
            role: finalRole,
            isSubscribed: finalSubscribed,
            isVerified: finalVerified,
            latitude: latitude || (existing[0] ? existing[0].latitude : null),
            longitude: longitude || (existing[0] ? existing[0].longitude : null),
            updatedAt: new Date(),
          },
        })
        .returning();

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "profile_update",
        screenName: "edit_profile",
        details: JSON.stringify({ name }),
      });

      res.json(result[0]);
    } catch (error: any) {
      console.error("Failed to save profile in Postgres:", error);
      res.status(500).json({ error: "Failed to save user profile" });
    }
  });

  // 1c. Get all registered user profiles (paginated, filtered, secure potential matches feed)
  app.get("/api/users/all", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      
      // Parse query params for pagination
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = (page - 1) * limit;

      // Parse filters
      const { gender, minAge, maxAge, interests, maxDistance } = req.query;

      // 1. Fetch already swiped user IDs
      const alreadySwiped = await db.select({ receiverUid: swipes.receiverUid })
        .from(swipes)
        .where(eq(swipes.senderUid, uid));
      const swipedUids = alreadySwiped.map(s => s.receiverUid);

      // 2. Fetch blocked/blocking user IDs
      const blocksList = await db.select()
        .from(blocks)
        .where(or(eq(blocks.blockerUid, uid), eq(blocks.blockedUid, uid)));
      const blockedUids = blocksList.map(b => b.blockerUid === uid ? b.blockedUid : b.blockerUid);

      // 3. Get current user's profile to check distance / locations
      const currentUserProfile = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
      const curLat = currentUserProfile[0]?.latitude ? parseFloat(currentUserProfile[0].latitude) : null;
      const curLon = currentUserProfile[0]?.longitude ? parseFloat(currentUserProfile[0].longitude) : null;
      const currentGender = currentUserProfile[0]?.gender;

      // Build SQL filters
      const conditions = [ne(users.uid, uid)]; // Exclude self
      
      if (swipedUids.length > 0) {
        conditions.push(notInArray(users.uid, swipedUids));
      }
      if (blockedUids.length > 0) {
        conditions.push(notInArray(users.uid, blockedUids));
      }

      // Apply gender-based filtering: a user with gender: 'Man' should only see users with gender: 'Woman' in Sparks/Discover, and vice versa.
      let targetGender = gender;
      if (!targetGender || targetGender === "all" || targetGender === "") {
        if (currentGender === "Man") {
          targetGender = "Woman";
        } else if (currentGender === "Woman") {
          targetGender = "Man";
        }
      }

      if (targetGender && typeof targetGender === "string" && targetGender !== "all" && targetGender !== "") {
        conditions.push(eq(users.gender, targetGender));
      }

      if (minAge) {
        conditions.push(gt(users.age, parseInt(minAge as string) - 1));
      }
      if (maxAge) {
        conditions.push(lt(users.age, parseInt(maxAge as string) + 1));
      }

      // Fetch potential users from DB
      const potentialMatches = await db.select().from(users)
        .where(and(...conditions));

      // Map and filter results in JS for more complex fields (interests, location/distance)
      let results = potentialMatches.map((u) => {
        // Calculate distance if coordinates are present
        let distance: number | null = null;
        if (curLat !== null && curLon !== null && u.latitude && u.longitude) {
          const uLat = parseFloat(u.latitude);
          const uLon = parseFloat(u.longitude);
          if (!isNaN(uLat) && !isNaN(uLon)) {
            distance = getDistance(curLat, curLon, uLat, uLon);
          }
        }

        // Parse photos string to array if necessary
        let photoArray: string[] = [];
        if (u.photos) {
          try {
            photoArray = typeof u.photos === 'string' ? JSON.parse(u.photos) : u.photos;
          } catch (e) {
            photoArray = [];
          }
        }
        if (u.photo && photoArray.length === 0) {
          photoArray = [u.photo];
        }

        return {
          uid: u.uid,
          name: u.name,
          username: u.username,
          photo: u.photo,
          photos: photoArray,
          bio: u.bio,
          age: u.age,
          gender: u.gender,
          interests: u.interests,
          isVerified: u.isVerified,
          isSubscribed: u.isSubscribed,
          distance: distance !== null ? Math.round(distance) : null,
          updatedAt: u.updatedAt,
        };
      });

      // Filter by max distance if requested
      if (maxDistance && typeof maxDistance === "string" && maxDistance !== "" && maxDistance !== "all") {
        const maxD = parseInt(maxDistance);
        results = results.filter(u => u.distance === null || u.distance <= maxD);
      }

      // Filter by interests if requested
      if (interests && typeof interests === "string" && interests.trim() !== "") {
        const queryInterests = interests.split(",").map(i => i.trim().toLowerCase());
        results = results.filter(u => {
          if (!u.interests) return false;
          const userInterests = u.interests.split(",").map(i => i.trim().toLowerCase());
          return queryInterests.some(qi => userInterests.includes(qi));
        });
      }

      // If results are fewer than 5, let's back fill with other registered users (excluding self) to ensure we always have 5 suggestions
      if (results.length < 5) {
        const backupUsers = await db.select().from(users)
          .where(ne(users.uid, uid))
          .limit(10);
        
        const backupResults = backupUsers.map((u) => {
          let photoArray: string[] = [];
          if (u.photos) {
            try {
              photoArray = typeof u.photos === 'string' ? JSON.parse(u.photos) : u.photos;
            } catch (e) {
              photoArray = [];
            }
          }
          if (u.photo && photoArray.length === 0) {
            photoArray = [u.photo];
          }
          return {
            uid: u.uid,
            name: u.name,
            username: u.username,
            photo: u.photo,
            photos: photoArray,
            bio: u.bio,
            age: u.age,
            gender: u.gender,
            interests: u.interests,
            isVerified: u.isVerified,
            isSubscribed: u.isSubscribed,
            distance: null,
            updatedAt: u.updatedAt,
          };
        });

        const existingUids = new Set(results.map(r => r.uid));
        for (const bu of backupResults) {
          if (!existingUids.has(bu.uid)) {
            results.push(bu);
            existingUids.add(bu.uid);
          }
        }
      }

      // Smart recommendation engine: sort potential matches by relevance
      const curInterests = currentUserProfile[0]?.interests 
        ? currentUserProfile[0].interests.split(",").map(i => i.trim().toLowerCase()) 
        : [];

      results = results.map(u => {
        const uInterests = u.interests
          ? (typeof u.interests === 'string' ? u.interests.split(",") : u.interests).map((i: string) => i.trim().toLowerCase())
          : [];
        const sharedCount = uInterests.filter((i: string) => curInterests.includes(i)).length;
        
        let score = sharedCount * 10;
        if (u.distance !== null) {
          score += Math.max(0, 15 - u.distance / 10); // closer matches get higher priority
        }
        if (u.isVerified) score += 5;
        if (u.isSubscribed) score += 3;

        return { ...u, recommendationScore: score };
      }).sort((a, b) => (b.recommendationScore || 0) - (a.recommendationScore || 0));

      // Paginate results manually
      const paginatedResults = results.slice(offset, offset + limit);

      res.json(paginatedResults);
    } catch (error: any) {
      console.error("Failed to fetch matches feed:", error);
      res.status(500).json({ error: "Failed to fetch matches feed" });
    }
  });

  // 1b. Search User Profiles in PostgreSQL
  app.get("/api/users/search", requireAuth, async (req: AuthRequest, res) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== "string" || q.trim() === "") {
        return res.json([]);
      }

      const searchPattern = `%${q.trim()}%`;
      const matchedUsers = await db
        .select()
        .from(users)
        .where(
          or(
            ilike(users.username, searchPattern),
            ilike(users.name, searchPattern),
            ilike(users.email, searchPattern)
          )
        )
        .limit(30);

      res.json(matchedUsers);
    } catch (error: any) {
      console.error("Failed to search users in Postgres:", error);
      res.status(500).json({ error: "Failed to search users" });
    }
  });

  // 2. Track Event
  app.post("/api/tracking/event", optionalAuth, async (req: AuthRequest, res) => {
    try {
      const { eventType, screenName, details } = req.body;
      const userUid = req.user ? req.user.uid : "guest";

      await db.insert(userTracking).values({
        userUid,
        eventType,
        screenName: screenName || null,
        details: details ? JSON.stringify(details) : null,
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Tracking event write failed:", error);
      res.status(500).json({ error: "Failed to log tracking event" });
    }
  });

  // 3. Get Tracking History for User Data Dashboard
  app.get("/api/tracking/history", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const trackingLogs = await db
        .select()
        .from(userTracking)
        .where(eq(userTracking.userUid, uid))
        .orderBy(desc(userTracking.timestamp));

      res.json(trackingLogs);
    } catch (error: any) {
      console.error("Failed to fetch tracking history:", error);
      res.status(500).json({ error: "Failed to fetch tracking data" });
    }
  });

  // 4. Get and Send Messages
  app.get("/api/messages", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { partnerUid } = req.query;

      // Automatically delete messages older than 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await db.delete(dbMessages)
        .where(lt(dbMessages.createdAt, twentyFourHoursAgo));

      if (!partnerUid || typeof partnerUid !== "string") {
        // Return all messages for the logged-in user to build the inbox conversation list
        const allUserMessages = await db
          .select()
          .from(dbMessages)
          .where(
            or(
              eq(dbMessages.senderUid, uid),
              eq(dbMessages.receiverUid, uid)
            )
          )
          .orderBy(dbMessages.createdAt);
        return res.json(allUserMessages);
      }

      const allMessages = await db
        .select()
        .from(dbMessages)
        .where(
          or(
            and(eq(dbMessages.senderUid, uid), eq(dbMessages.receiverUid, partnerUid)),
            and(eq(dbMessages.senderUid, partnerUid), eq(dbMessages.receiverUid, uid))
          )
        )
        .orderBy(dbMessages.createdAt);

      res.json(allMessages);
    } catch (error: any) {
      console.error("Failed to fetch messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  app.post("/api/messages/delete", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { id, type } = req.body; // type: 'me' or 'everyone'

      if (!id) {
        return res.status(400).json({ error: "Message ID is required" });
      }

      const msgList = await db.select().from(dbMessages).where(eq(dbMessages.id, id)).limit(1);
      if (msgList.length === 0) {
        return res.status(404).json({ error: "Message not found" });
      }

      const msg = msgList[0];

      if (type === 'everyone') {
        if (msg.senderUid !== uid) {
          return res.status(403).json({ error: "Only the sender can delete this message for everyone" });
        }
        // Delete completely from the backend
        await db.delete(dbMessages).where(eq(dbMessages.id, id));
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to delete message:", error);
      res.status(500).json({ error: "Failed to delete message" });
    }
  });

  app.post("/api/messages", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { receiverUid, text, image, timeString } = req.body;

      if (!receiverUid) {
        return res.status(400).json({ error: "receiverUid is required" });
      }

      // Check if follow exists and is accepted
      const followRecord = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followerUid, uid),
          eq(follows.followingUid, receiverUid)
        ))
        .limit(1);

      if (followRecord.length === 0) {
        return res.status(403).json({ error: "You must follow this user first before messaging them." });
      }

      if (followRecord[0].status === "pending") {
        return res.status(403).json({ error: "Follow request pending — you can message once accepted" });
      }

      const result = await db.insert(dbMessages)
        .values({
          senderUid: uid,
          receiverUid,
          text: text || null,
          image: image || null,
          timeString: timeString || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isRead: false,
        })
        .returning();

      // Retrieve sender profile info for notification
      const sender = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
      const senderName = sender[0]?.name || "Someone";

      // Insert message notification for the receiver
      await db.insert(dbNotifications).values({
        userUid: receiverUid,
        senderUid: uid,
        type: 'message',
        text: `${senderName} sent you a message: "${text ? (text.length > 30 ? text.substring(0, 30) + '...' : text) : '📷 Photo'}"`,
        isRead: false,
      });

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "send_message",
        screenName: "chat",
        details: JSON.stringify({ recipient: receiverUid, textLength: text ? text.length : 0 }),
      });

      res.json(result[0]);
    } catch (error: any) {
      console.error("Failed to send message:", error);
      res.status(500).json({ error: "Failed to save message" });
    }
  });

  // 5. Swipe Actions and Matches
  app.post("/api/swipes", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { receiverUid, action } = req.body; // 'like', 'pass', 'super'

      if (!receiverUid || !action) {
        return res.status(400).json({ error: "receiverUid and action are required" });
      }

      const result = await db.insert(swipes)
        .values({
          senderUid: uid,
          receiverUid,
          action,
        })
        .returning();

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: `swipe_${action}`,
        screenName: "discover",
        details: JSON.stringify({ swipedUser: receiverUid }),
      });

      // Check for Mutual Match: Has receiverUid also swiped 'like' or 'super' on uid?
      const reciprocalSwipes = await db
        .select()
        .from(swipes)
        .where(
          and(
            eq(swipes.senderUid, receiverUid),
            eq(swipes.receiverUid, uid),
            or(eq(swipes.action, "like"), eq(swipes.action, "super"))
          )
        );

      const isMatch = reciprocalSwipes.length > 0 && (action === "like" || action === "super");

      if (isMatch) {
        // Track match event
        await db.insert(userTracking).values({
          userUid: uid,
          eventType: "mutual_match",
          screenName: "discover",
          details: JSON.stringify({ matchedWith: receiverUid }),
        });
      }

      res.json({ swipe: result[0], isMatch });
    } catch (error: any) {
      console.error("Failed to record swipe:", error);
      res.status(500).json({ error: "Failed to record swipe" });
    }
  });

  app.delete("/api/swipes", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      await db.delete(swipes).where(eq(swipes.senderUid, uid));
      res.json({ success: true, message: "Swipes reset successfully" });
    } catch (error: any) {
      console.error("Failed to reset swipes:", error);
      res.status(500).json({ error: "Failed to reset swipes" });
    }
  });

  // Get mutual follower/matched list
  app.get("/api/swipes/mutual", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;

      // Users you swiped 'like' or 'super'
      const likesSent = await db
        .select()
        .from(swipes)
        .where(
          and(
            eq(swipes.senderUid, uid),
            or(eq(swipes.action, "like"), eq(swipes.action, "super"))
          )
        );

      const likedUserIds = likesSent.map((s) => s.receiverUid);

      if (likedUserIds.length === 0) {
        return res.json([]);
      }

      // Users who liked you back
      const reciprocalLikes = await db
        .select()
        .from(swipes)
        .where(
          and(
            eq(swipes.receiverUid, uid),
            or(eq(swipes.action, "like"), eq(swipes.action, "super"))
          )
        );

      const reciprocalUserIds = new Set(reciprocalLikes.map((s) => s.senderUid));
      const mutualIds = likedUserIds.filter((id) => reciprocalUserIds.has(id));

      res.json(mutualIds);
    } catch (error: any) {
      console.error("Failed to fetch mutual matches:", error);
      res.status(500).json({ error: "Failed to fetch mutual matches" });
    }
  });

  // 6. Stories Endpoints
  app.post("/api/stories", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { photo, visibility } = req.body;

      if (!photo) {
        return res.status(400).json({ error: "Photo is required for stories" });
      }

      const result = await db.insert(stories)
        .values({
          userUid: uid,
          photo,
          visibility: visibility || "followers",
        })
        .returning();

      // Retrieve story creator profile info for notifications
      const creator = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
      const creatorName = creator[0]?.name || "Someone";

      // Find all accepted followers of this user
      const followersList = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followingUid, uid),
          eq(follows.status, 'accepted')
        ));

      // Create a story notification for each follower (prevent duplicate spam within 5 mins)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      for (const f of followersList) {
        const existingStoryNotif = await db.select()
          .from(dbNotifications)
          .where(and(
            eq(dbNotifications.userUid, f.followerUid),
            eq(dbNotifications.senderUid, uid),
            eq(dbNotifications.type, 'story'),
            gt(dbNotifications.createdAt, fiveMinutesAgo)
          ))
          .limit(1);

        if (existingStoryNotif.length === 0) {
          await db.insert(dbNotifications).values({
            userUid: f.followerUid,
            senderUid: uid,
            type: 'story',
            text: `${creatorName} added a new story!`,
            isRead: false,
          });
        }
      }

      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "post_story",
        screenName: "stories",
      });

      res.json(result[0]);
    } catch (error: any) {
      console.error("Failed to post story:", error);
      res.status(500).json({ error: "Failed to post story" });
    }
  });

  app.delete("/api/stories/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const storyId = parseInt(req.params.id, 10);

      if (isNaN(storyId)) {
        return res.status(400).json({ error: "Invalid story ID" });
      }

      // Check if story exists and belongs to the current user
      const existingStory = await db.select()
        .from(stories)
        .where(eq(stories.id, storyId))
        .limit(1);

      if (existingStory.length === 0) {
        return res.status(404).json({ error: "Story not found" });
      }

      if (existingStory[0].userUid !== uid) {
        return res.status(403).json({ error: "Unauthorized to delete this story" });
      }

      // Delete views first
      await db.delete(storyViews).where(eq(storyViews.storyId, storyId));

      // Delete the story itself
      await db.delete(stories).where(eq(stories.id, storyId));

      res.json({ success: true, message: "Story deleted successfully" });
    } catch (error: any) {
      console.error("Failed to delete story:", error);
      res.status(500).json({ error: "Failed to delete story" });
    }
  });

  app.get("/api/stories", optionalAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Clean up old story records asynchronously
      db.delete(stories).where(lt(stories.createdAt, twentyFourHoursAgo))
        .catch(err => console.error("Story cleanup failed:", err));

      // Fetch active stories joined with users table to get username and photo
      const activeStories = await db.select({
        id: stories.id,
        userUid: stories.userUid,
        photo: stories.photo,
        createdAt: stories.createdAt,
        visibility: stories.visibility,
        name: users.name,
        username: users.username,
        userPhoto: users.photo
      })
      .from(stories)
      .innerJoin(users, eq(stories.userUid, users.uid))
      .where(gt(stories.createdAt, twentyFourHoursAgo))
      .orderBy(desc(stories.createdAt));

      let filteredStories = [];

      if (uid) {
        // Logged-in user
        // Filter out stories from blocked users
        const blocksList = await db.select()
          .from(blocks)
          .where(or(eq(blocks.blockerUid, uid), eq(blocks.blockedUid, uid)));
        const blockedUids = new Set(blocksList.map(b => b.blockerUid === uid ? b.blockedUid : b.blockerUid));

        // Get mutual follow connections:
        // People the user follows (accepted)
        const weFollow = await db.select({ followingUid: follows.followingUid })
          .from(follows)
          .where(and(
            eq(follows.followerUid, uid),
            eq(follows.status, 'accepted')
          ));
        const weFollowUids = new Set(weFollow.map(f => f.followingUid));

        // People who follow the user (accepted)
        const followUs = await db.select({ followerUid: follows.followerUid })
          .from(follows)
          .where(and(
            eq(follows.followingUid, uid),
            eq(follows.status, 'accepted')
          ));
        const followUsUids = new Set(followUs.map(f => f.followerUid));

        const mutualUids = new Set([...weFollowUids].filter(id => followUsUids.has(id)));

        filteredStories = activeStories.filter(s => {
          if (blockedUids.has(s.userUid)) return false;
          if (s.userUid === uid) return true;
          if (s.visibility === 'public') return true;
          return mutualUids.has(s.userUid);
        });
      } else {
        // Guest/unauthenticated user - only see public stories
        filteredStories = activeStories.filter(s => s.visibility === 'public');
      }

      // Map with view counts and viewers if owned by the user
      const results = [];
      for (const story of filteredStories) {
        let viewers: any[] = [];
        if (uid && story.userUid === uid) {
          viewers = await db.select({
            uid: users.uid,
            name: users.name,
            photo: users.photo,
            username: users.username,
          })
          .from(storyViews)
          .innerJoin(users, eq(storyViews.viewerUid, users.uid))
          .where(eq(storyViews.storyId, story.id));
        }
        results.push({
          ...story,
          viewCount: viewers.length,
          viewers,
        });
      }

      res.json(results);
    } catch (error: any) {
      console.error("Failed to fetch stories:", error);
      res.status(500).json({ error: "Failed to fetch stories" });
    }
  });

  // 7. Block & Report Endpoints
  app.post("/api/users/block", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { blockedUid } = req.body;

      if (!blockedUid) {
        return res.status(400).json({ error: "blockedUid is required" });
      }

      await db.insert(blocks).values({
        blockerUid: uid,
        blockedUid,
      });

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "block_user",
        screenName: "chat",
        details: JSON.stringify({ blockedUser: blockedUid }),
      });

      res.json({ success: true, message: "User blocked successfully." });
    } catch (error: any) {
      console.error("Failed to block user:", error);
      res.status(500).json({ error: "Failed to block user" });
    }
  });

  app.get("/api/users/blocked", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const blockedList = await db.select({
        uid: users.uid,
        name: users.name,
        photo: users.photo,
        username: users.username,
        age: users.age,
      })
      .from(blocks)
      .innerJoin(users, eq(blocks.blockedUid, users.uid))
      .where(eq(blocks.blockerUid, uid));

      res.json(blockedList);
    } catch (error: any) {
      console.error("Failed to fetch blocked users:", error);
      res.status(500).json({ error: "Failed to fetch blocked users" });
    }
  });

  app.post("/api/users/unblock", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { blockedUid } = req.body;

      if (!blockedUid) {
        return res.status(400).json({ error: "blockedUid is required" });
      }

      await db.delete(blocks)
        .where(and(
          eq(blocks.blockerUid, uid),
          eq(blocks.blockedUid, blockedUid)
        ));

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "unblock_user",
        screenName: "settings",
        details: JSON.stringify({ unblockedUser: blockedUid }),
      });

      res.json({ success: true, message: "User unblocked successfully." });
    } catch (error: any) {
      console.error("Failed to unblock user:", error);
      res.status(500).json({ error: "Failed to unblock user" });
    }
  });

  app.post("/api/users/delete", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;

      // Delete user's rows from all tables in Postgres in sequence
      await db.delete(dbNotifications).where(eq(dbNotifications.userUid, uid));
      await db.delete(follows).where(or(eq(follows.followerUid, uid), eq(follows.followingUid, uid)));
      await db.delete(storyViews).where(eq(storyViews.viewerUid, uid));
      await db.delete(stories).where(eq(stories.userUid, uid));
      await db.delete(dbMessages).where(or(eq(dbMessages.senderUid, uid), eq(dbMessages.receiverUid, uid)));
      await db.delete(swipes).where(or(eq(swipes.senderUid, uid), eq(swipes.receiverUid, uid)));
      await db.delete(reports).where(or(eq(reports.reporterUid, uid), eq(reports.reportedUid, uid)));
      await db.delete(blocks).where(or(eq(blocks.blockerUid, uid), eq(blocks.blockedUid, uid)));
      await db.delete(userTracking).where(eq(userTracking.userUid, uid));
      await db.delete(users).where(eq(users.uid, uid));

      res.json({ success: true, message: "User account deleted successfully from PostgreSQL." });
    } catch (error: any) {
      console.error("Failed to delete user data:", error);
      res.status(500).json({ error: "Failed to delete user database records" });
    }
  });

  app.post("/api/users/report", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { reportedUid, reason } = req.body;

      if (!reportedUid) {
        return res.status(400).json({ error: "reportedUid is required" });
      }

      await db.insert(reports).values({
        reporterUid: uid,
        reportedUid,
        reason: reason || null,
      });

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "report_user",
        screenName: "chat",
        details: JSON.stringify({ reportedUser: reportedUid, reason }),
      });

      res.json({ success: true, message: "User reported successfully." });
    } catch (error: any) {
      console.error("Failed to report user:", error);
      res.status(500).json({ error: "Failed to report user" });
    }
  });

  // 8. Aura Gold Subscription Endpoint
  app.post("/api/subscription/subscribe", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;

      const result = await db.update(users)
        .set({ isSubscribed: true })
        .where(eq(users.uid, uid))
        .returning();

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "subscribe_gold",
        screenName: "gold",
      });

      res.json({ success: true, user: result[0] });
    } catch (error: any) {
      console.error("Failed to subscribe user to Gold:", error);
      res.status(500).json({ error: "Failed to subscribe to Gold" });
    }
  });

  // 9. Profile Verification Endpoint
  app.post("/api/users/verify", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;

      const result = await db.update(users)
        .set({ isVerified: true })
        .where(eq(users.uid, uid))
        .returning();

      // Log tracking event
      await db.insert(userTracking).values({
        userUid: uid,
        eventType: "verify_profile",
        screenName: "onboarding",
      });

      res.json({ success: true, user: result[0] });
    } catch (error: any) {
      console.error("Failed to verify user profile:", error);
      res.status(500).json({ error: "Failed to verify profile" });
    }
  });

  // 10. Gemini AI Endpoints
  app.post("/api/ai/bio", requireAuth, async (req: AuthRequest, res) => {
    try {
      const { keywords, interests } = req.body;
      const prompt = `Write a charming, authentic, and slightly witty dating profile bio based on these keywords/interests: "${keywords || ''}" and "${interests || ''}". Keep it concise, engaging, and under 150 words. Do not use generic cliches. Just output the bio text directly without any quotes or titles.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      res.json({ bio: response.text?.trim() });
    } catch (error: any) {
      console.error("Failed to generate bio with Gemini AI:", error);
      res.status(500).json({ error: "Failed to generate bio suggestion. Please try again." });
    }
  });

  app.post("/api/ai/icebreaker", requireAuth, async (req: AuthRequest, res) => {
    try {
      const { partnerName, partnerBio, partnerInterests } = req.body;
      const prompt = `Write 3 unique, charming, and highly personalized icebreakers/opening lines that I can send to ${partnerName || 'my match'}.
Here is their profile info:
Bio: "${partnerBio || 'No bio provided'}"
Interests: "${partnerInterests || 'No interests provided'}"

Provide 3 options ranging from witty/playful to genuine. Keep each icebreaker short and engaging. Format the output as a simple JSON array of strings: ["option 1", "option 2", "option 3"]. Output ONLY the valid JSON array without any markdown formatting block or text.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      let cleanText = response.text?.trim() || "[]";
      // Remove any markdown code blocks
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.substring(7, cleanText.length - 3).trim();
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.substring(3, cleanText.length - 3).trim();
      }

      const options = JSON.parse(cleanText);
      res.json({ icebreakers: options });
    } catch (error: any) {
      console.error("Failed to generate icebreakers with Gemini AI:", error);
      res.status(500).json({ error: "Failed to generate icebreaker suggestions. Please try again." });
    }
  });

  // 8. Message Read Receipts & Recents Endpoints
  app.patch("/api/messages/read", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { partnerUid } = req.body;

      if (!partnerUid) {
        return res.status(400).json({ error: "partnerUid is required" });
      }

      await db.update(dbMessages)
        .set({ isRead: true })
        .where(and(
          eq(dbMessages.senderUid, partnerUid),
          eq(dbMessages.receiverUid, uid),
          eq(dbMessages.isRead, false)
        ));

      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to mark messages as read:", error);
      res.status(500).json({ error: "Failed to mark messages as read" });
    }
  });

  app.get("/api/messages/recents", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;

      // Automatically delete messages older than 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await db.delete(dbMessages)
        .where(lt(dbMessages.createdAt, twentyFourHoursAgo));

      // Fetch all messages involving the current user
      const allMsgs = await db.select()
        .from(dbMessages)
        .where(or(
          eq(dbMessages.senderUid, uid),
          eq(dbMessages.receiverUid, uid)
        ))
        .orderBy(desc(dbMessages.createdAt));

      // Group by partnerUid to find last message
      const partnersMap = new Map<string, { lastMessage: any }>();
      for (const msg of allMsgs) {
        const partnerUid = msg.senderUid === uid ? msg.receiverUid : msg.senderUid;
        if (!partnersMap.has(partnerUid)) {
          partnersMap.set(partnerUid, { lastMessage: msg });
        }
      }

      const partnerUids = Array.from(partnersMap.keys());
      if (partnerUids.length === 0) {
        return res.json([]);
      }

      // Fetch partner profiles
      const partnerProfiles = await db.select()
        .from(users)
        .where(inArray(users.uid, partnerUids));

      const results = [];
      for (const p of partnerProfiles) {
        const lastMsgInfo = partnersMap.get(p.uid);
        
        // Count unread messages from this partner to current user
        const unreadCountRes = await db.select()
          .from(dbMessages)
          .where(and(
            eq(dbMessages.senderUid, p.uid),
            eq(dbMessages.receiverUid, uid),
            eq(dbMessages.isRead, false)
          ));

        // Check if partner has an active story
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const activeStoriesCount = await db.select()
          .from(stories)
          .where(and(
            eq(stories.userUid, p.uid),
            gt(stories.createdAt, twentyFourHoursAgo)
          ));

        results.push({
          uid: p.uid,
          name: p.name || p.username || "Aura User",
          username: p.username,
          photo: p.photo,
          lastMessageText: lastMsgInfo?.lastMessage.text || "",
          lastMessageTime: lastMsgInfo?.lastMessage.timeString || "",
          lastMessageCreatedAt: lastMsgInfo?.lastMessage.createdAt || new Date(),
          unreadCount: unreadCountRes.length,
          hasStory: activeStoriesCount.length > 0,
        });
      }

      // Sort by lastMessageCreatedAt desc
      results.sort((a, b) => new Date(b.lastMessageCreatedAt).getTime() - new Date(a.lastMessageCreatedAt).getTime());

      res.json(results);
    } catch (error: any) {
      console.error("Failed to fetch recent chats:", error);
      res.status(500).json({ error: "Failed to fetch recent chats" });
    }
  });

  // 9. Story Views & Specific User Stories
  app.post("/api/stories/:id/view", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const storyId = parseInt(req.params.id);

      if (isNaN(storyId)) {
        return res.status(400).json({ error: "Invalid story ID" });
      }

      // Get story owner to ensure the viewer doesn't view their own story to record
      const storyRec = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
      if (storyRec.length === 0) {
        return res.status(404).json({ error: "Story not found" });
      }

      if (storyRec[0].userUid === uid) {
        return res.json({ success: true, message: "Own story view not recorded" });
      }

      // Check if view already exists
      const existing = await db.select()
        .from(storyViews)
        .where(and(
          eq(storyViews.storyId, storyId),
          eq(storyViews.viewerUid, uid)
        ))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(storyViews).values({
          storyId,
          viewerUid: uid,
        });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to record story view:", error);
      res.status(500).json({ error: "Failed to record story view" });
    }
  });

  app.get("/api/stories/user/:userUid", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const targetUid = req.params.userUid;
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Check visibility: must be own profile OR must have accepted follow
      let isAllowed = false;
      if (targetUid === uid) {
        isAllowed = true;
      } else {
        const followRecord = await db.select()
          .from(follows)
          .where(and(
            eq(follows.followerUid, uid),
            eq(follows.followingUid, targetUid),
            eq(follows.status, 'accepted')
          ))
          .limit(1);
        if (followRecord.length > 0) {
          isAllowed = true;
        }
      }

      if (!isAllowed) {
        return res.status(403).json({ error: "You must follow this user (request accepted) to view their stories." });
      }

      const userStories = await db.select({
        id: stories.id,
        userUid: stories.userUid,
        photo: stories.photo,
        createdAt: stories.createdAt,
      })
      .from(stories)
      .where(and(
        eq(stories.userUid, targetUid),
        gt(stories.createdAt, twentyFourHoursAgo)
      ))
      .orderBy(desc(stories.createdAt));

      const results = [];
      for (const story of userStories) {
        let viewers: any[] = [];
        if (targetUid === uid) {
          viewers = await db.select({
            uid: users.uid,
            name: users.name,
            photo: users.photo,
            username: users.username,
          })
          .from(storyViews)
          .innerJoin(users, eq(storyViews.viewerUid, users.uid))
          .where(eq(storyViews.storyId, story.id));
        }
        results.push({
          ...story,
          viewCount: viewers.length,
          viewers,
        });
      }

      res.json(results);
    } catch (error: any) {
      console.error("Failed to fetch user stories:", error);
      res.status(500).json({ error: "Failed to fetch user stories" });
    }
  });

  // 10. Follow Request / Management Endpoints
  app.post("/api/follows", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { followingUid } = req.body;

      if (!followingUid) {
        return res.status(400).json({ error: "followingUid is required" });
      }

      if (uid === followingUid) {
        return res.status(400).json({ error: "You cannot follow yourself" });
      }

      // Check if follow record already exists
      const existing = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followerUid, uid),
          eq(follows.followingUid, followingUid)
        ))
        .limit(1);

      if (existing.length > 0) {
        return res.json({ success: true, follow: existing[0], message: "Already following or request pending" });
      }

      // Insert new follow as pending
      const result = await db.insert(follows).values({
        followerUid: uid,
        followingUid,
        status: 'pending',
      }).returning();

      // Get sender details to format notification
      const sender = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
      const senderName = sender[0]?.name || "Someone";

      // Check if duplicate notification of type 'follow' already exists (either isRead = false OR created within the last 5 minutes)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicate = await db.select()
        .from(dbNotifications)
        .where(and(
          eq(dbNotifications.userUid, followingUid),
          eq(dbNotifications.senderUid, uid),
          eq(dbNotifications.type, 'follow'),
          or(
            eq(dbNotifications.isRead, false),
            gt(dbNotifications.createdAt, fiveMinutesAgo)
          )
        ))
        .limit(1);

      if (duplicate.length === 0) {
        // Create a notification for followingUid
        await db.insert(dbNotifications).values({
          userUid: followingUid,
          senderUid: uid,
          type: 'follow',
          text: `${senderName} requested to follow you.`,
          isRead: false,
        });
      }

      res.json({ success: true, follow: result[0] });
    } catch (error: any) {
      console.error("Failed to follow user:", error);
      res.status(500).json({ error: "Failed to follow user" });
    }
  });

  app.post("/api/follows/accept", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid; // target (followingUid)
      const { followerUid } = req.body;

      if (!followerUid) {
        return res.status(400).json({ error: "followerUid is required" });
      }

      // Update follow status to accepted
      const updated = await db.update(follows)
        .set({ status: 'accepted' })
        .where(and(
          eq(follows.followerUid, followerUid),
          eq(follows.followingUid, uid)
        ))
        .returning();

      if (updated.length === 0) {
        return res.status(404).json({ error: "Follow request not found." });
      }

      const acceptor = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
      const acceptorName = acceptor[0]?.name || "Someone";

      // Check if duplicate notification of type 'follow_accepted' already exists (either isRead = false OR created within the last 5 minutes)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const duplicateAccept = await db.select()
        .from(dbNotifications)
        .where(and(
          eq(dbNotifications.userUid, followerUid),
          eq(dbNotifications.senderUid, uid),
          eq(dbNotifications.type, 'follow_accepted'),
          or(
            eq(dbNotifications.isRead, false),
            gt(dbNotifications.createdAt, fiveMinutesAgo)
          )
        ))
        .limit(1);

      if (duplicateAccept.length === 0) {
        await db.insert(dbNotifications).values({
          userUid: followerUid,
          senderUid: uid,
          type: 'follow_accepted',
          text: `${acceptorName} accepted your follow request!`,
          isRead: false,
        });
      }

      // Update the original "requested to follow you" notification to a plain text system notification
      const follower = await db.select().from(users).where(eq(users.uid, followerUid)).limit(1);
      const followerName = follower[0]?.name || "Someone";

      await db.update(dbNotifications)
        .set({
          type: 'system',
          text: `You accepted ${followerName}'s follow request.`,
          isRead: true
        })
        .where(and(
          eq(dbNotifications.userUid, uid),
          eq(dbNotifications.senderUid, followerUid),
          eq(dbNotifications.type, 'follow')
        ));

      res.json({ success: true, follow: updated[0] });
    } catch (error: any) {
      console.error("Failed to accept follow request:", error);
      res.status(500).json({ error: "Failed to accept follow request" });
    }
  });

  app.post("/api/follows/decline", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { followerUid } = req.body;

      if (!followerUid) {
        return res.status(400).json({ error: "followerUid is required" });
      }

      // Delete the follow request
      await db.delete(follows)
        .where(and(
          eq(follows.followerUid, followerUid),
          eq(follows.followingUid, uid),
          eq(follows.status, 'pending')
        ));

      // Update the original "requested to follow you" notification to a plain text system notification
      const follower = await db.select().from(users).where(eq(users.uid, followerUid)).limit(1);
      const followerName = follower[0]?.name || "Someone";

      await db.update(dbNotifications)
        .set({
          type: 'system',
          text: `You declined ${followerName}'s follow request.`,
          isRead: true
        })
        .where(and(
          eq(dbNotifications.userUid, uid),
          eq(dbNotifications.senderUid, followerUid),
          eq(dbNotifications.type, 'follow')
        ));

      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to decline follow request:", error);
      res.status(500).json({ error: "Failed to decline follow request" });
    }
  });

  app.post("/api/follows/unfollow", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { followingUid } = req.body;

      if (!followingUid) {
        return res.status(400).json({ error: "followingUid is required" });
      }

      await db.delete(follows)
        .where(and(
          eq(follows.followerUid, uid),
          eq(follows.followingUid, followingUid)
        ));

      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to unfollow user:", error);
      res.status(500).json({ error: "Failed to unfollow user" });
    }
  });

  app.get("/api/follows/followers/:uid", requireAuth, async (req: AuthRequest, res) => {
    try {
      const loggedInUid = req.user.uid;
      const targetUid = req.params.uid;

      const followersList = await db.select({
        uid: users.uid,
        name: users.name,
        username: users.username,
        photo: users.photo,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followerUid, users.uid))
      .where(and(
        eq(follows.followingUid, targetUid),
        eq(follows.status, 'accepted')
      ));

      const results = [];
      for (const f of followersList) {
        const isFollowing = await db.select()
          .from(follows)
          .where(and(
            eq(follows.followerUid, loggedInUid),
            eq(follows.followingUid, f.uid)
          ))
          .limit(1);

        results.push({
          ...f,
          isFollowing: isFollowing.length > 0 ? isFollowing[0].status : 'none',
        });
      }

      res.json(results);
    } catch (error: any) {
      console.error("Failed to fetch followers list:", error);
      res.status(500).json({ error: "Failed to fetch followers list" });
    }
  });

  app.get("/api/follows/following/:uid", requireAuth, async (req: AuthRequest, res) => {
    try {
      const loggedInUid = req.user.uid;
      const targetUid = req.params.uid;

      const followingList = await db.select({
        uid: users.uid,
        name: users.name,
        username: users.username,
        photo: users.photo,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followingUid, users.uid))
      .where(and(
        eq(follows.followerUid, targetUid),
        eq(follows.status, 'accepted')
      ));

      const results = [];
      for (const f of followingList) {
        const isFollowing = await db.select()
          .from(follows)
          .where(and(
            eq(follows.followerUid, loggedInUid),
            eq(follows.followingUid, f.uid)
          ))
          .limit(1);

        results.push({
          ...f,
          isFollowing: isFollowing.length > 0 ? isFollowing[0].status : 'none',
        });
      }

      res.json(results);
    } catch (error: any) {
      console.error("Failed to fetch following list:", error);
      res.status(500).json({ error: "Failed to fetch following list" });
    }
  });

  // 11. Individual Profile Fetch with Relationship Status & Stats
  app.get("/api/users/profile/:uid", requireAuth, async (req: AuthRequest, res) => {
    try {
      const loggedInUid = req.user.uid;
      const targetUid = req.params.uid;

      const userList = await db.select().from(users).where(eq(users.uid, targetUid)).limit(1);
      if (userList.length === 0) {
        return res.status(404).json({ error: "User profile not found" });
      }

      const u = userList[0];

      let photoArray: string[] = [];
      if (u.photos) {
        try {
          photoArray = typeof u.photos === 'string' ? JSON.parse(u.photos) : u.photos;
        } catch (e) {
          photoArray = [];
        }
      }
      if (u.photo && photoArray.length === 0) {
        photoArray = [u.photo];
      }

      const followSent = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followerUid, loggedInUid),
          eq(follows.followingUid, targetUid)
        ))
        .limit(1);

      const followReceived = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followerUid, targetUid),
          eq(follows.followingUid, loggedInUid)
        ))
        .limit(1);

      const followersCountRes = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followingUid, targetUid),
          eq(follows.status, 'accepted')
        ));
      
      const followingCountRes = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followerUid, targetUid),
          eq(follows.status, 'accepted')
        ));

      res.json({
        uid: u.uid,
        name: u.name,
        username: u.username,
        photo: u.photo,
        photos: photoArray,
        bio: u.bio,
        age: u.age,
        gender: u.gender,
        interests: u.interests,
        isVerified: u.isVerified,
        isSubscribed: u.isSubscribed,
        updatedAt: u.updatedAt,
        relationSent: followSent[0] ? followSent[0].status : 'none',
        relationReceived: followReceived[0] ? followReceived[0].status : 'none',
        followersCount: followersCountRes.length,
        followingCount: followingCountRes.length,
      });
    } catch (error: any) {
      console.error("Failed to fetch individual user profile:", error);
      res.status(500).json({ error: "Failed to fetch user profile" });
    }
  });

  // 12. Notifications Endpoints
  app.get("/api/notifications", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;

      // Automatically expire/delete notifications after 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await db.delete(dbNotifications)
        .where(lt(dbNotifications.createdAt, twentyFourHoursAgo));

      const notifs = await db.select({
        id: dbNotifications.id,
        userUid: dbNotifications.userUid,
        senderUid: dbNotifications.senderUid,
        type: dbNotifications.type,
        text: dbNotifications.text,
        isRead: dbNotifications.isRead,
        createdAt: dbNotifications.createdAt,
        senderName: users.name,
        senderPhoto: users.photo,
        senderUsername: users.username,
      })
      .from(dbNotifications)
      .innerJoin(users, eq(dbNotifications.senderUid, users.uid))
      .where(eq(dbNotifications.userUid, uid))
      .orderBy(desc(dbNotifications.createdAt));

      res.json(notifs);
    } catch (error: any) {
      console.error("Failed to fetch notifications:", error);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  app.post("/api/notifications", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { receiverUid, type, text } = req.body;

      if (!receiverUid || !text) {
        return res.status(400).json({ error: "receiverUid and text are required" });
      }

      const result = await db.insert(dbNotifications).values({
        userUid: receiverUid,
        senderUid: uid,
        type: type || 'system',
        text,
        isRead: false,
      }).returning();

      res.json(result[0]);
    } catch (error: any) {
      console.error("Failed to create notification:", error);
      res.status(500).json({ error: "Failed to create notification" });
    }
  });

  app.post("/api/notifications/read", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { id } = req.body;

      if (id) {
        await db.update(dbNotifications)
          .set({ isRead: true })
          .where(and(
            eq(dbNotifications.id, id),
            eq(dbNotifications.userUid, uid)
          ));
      } else {
        await db.update(dbNotifications)
          .set({ isRead: true })
          .where(eq(dbNotifications.userUid, uid));
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to mark notifications as read:", error);
      res.status(500).json({ error: "Failed to mark notifications as read" });
    }
  });

  app.post("/api/notifications/clear", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      await db.delete(dbNotifications).where(eq(dbNotifications.userUid, uid));
      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to clear notifications:", error);
      res.status(500).json({ error: "Failed to clear notifications" });
    }
  });

  app.post("/api/notifications/delete", requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user.uid;
      const { id } = req.body;
      if (!id) {
        return res.status(400).json({ error: "Notification ID is required" });
      }
      await db.delete(dbNotifications).where(and(
        eq(dbNotifications.id, id),
        eq(dbNotifications.userUid, uid)
      ));
      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to delete notification:", error);
      res.status(500).json({ error: "Failed to delete notification" });
    }
  });

  // 11b. Public Profile Fetch by Username (No Auth Required)
  app.get("/api/public/profile/username/:username", async (req, res) => {
    try {
      const { username } = req.params;
      const userList = await db.select().from(users).where(eq(users.username, username)).limit(1);
      if (userList.length === 0) {
        return res.status(404).json({ error: "User profile not found" });
      }

      const u = userList[0];

      let photoArray: string[] = [];
      if (u.photos) {
        try {
          photoArray = typeof u.photos === 'string' ? JSON.parse(u.photos) : u.photos;
        } catch (e) {
          photoArray = [];
        }
      }
      if (u.photo && photoArray.length === 0) {
        photoArray = [u.photo];
      }

      const followersCountRes = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followingUid, u.uid),
          eq(follows.status, 'accepted')
        ));
      
      const followingCountRes = await db.select()
        .from(follows)
        .where(and(
          eq(follows.followerUid, u.uid),
          eq(follows.status, 'accepted')
        ));

      res.json({
        id: u.uid,
        uid: u.uid,
        name: u.name,
        username: u.username,
        photo: u.photo,
        photos: photoArray,
        bio: u.bio,
        age: u.age,
        gender: u.gender,
        interests: u.interests ? u.interests.split(',') : [],
        isVerified: u.isVerified,
        isSubscribed: u.isSubscribed,
        followersCount: followersCountRes.length,
        followingCount: followingCountRes.length,
      });
    } catch (error: any) {
      console.error("Failed to fetch public user profile:", error);
      res.status(500).json({ error: "Failed to fetch public profile" });
    }
  });

  // Intercept public profile URLs for Open Graph dynamic preview injection
  app.get(["/u/:username", "/profile/:username"], async (req, res, next) => {
    try {
      const { username } = req.params;
      const userList = await db.select().from(users).where(eq(users.username, username)).limit(1);
      
      let htmlPath = "";
      if (process.env.NODE_ENV !== "production") {
        htmlPath = path.join(process.cwd(), "index.html");
      } else {
        htmlPath = path.join(process.cwd(), "dist", "index.html");
      }
      
      const fs = await import("fs");
      if (!fs.existsSync(htmlPath)) {
        return next();
      }
      
      let html = fs.readFileSync(htmlPath, "utf-8");
      
      if (userList.length > 0) {
        const u = userList[0];
        const title = `${u.name || username} (@${u.username || username}) | Aura`;
        const description = u.bio || "Find your spark on Aura - the premium dating experience.";
        const image = u.photo || "https://images.unsplash.com/photo-1518199266791-5375a83190b7";
        
        const ogMeta = `
          <title>${title}</title>
          <meta name="description" content="${description}" />
          <meta property="og:title" content="${title}" />
          <meta property="og:description" content="${description}" />
          <meta property="og:image" content="${image}" />
          <meta property="og:type" content="profile" />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content="${title}" />
          <meta name="twitter:description" content="${description}" />
          <meta name="twitter:image" content="${image}" />
        `;
        html = html.replace("<head>", `<head>${ogMeta}`);
      }
      
      res.send(html);
    } catch (error) {
      console.error("Failed to generate public profile dynamic metadata:", error);
      next();
    }
  });

  // Vite middleware for development or static serving for production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
