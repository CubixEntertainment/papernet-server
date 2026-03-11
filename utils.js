// deno-lint-ignore-file
import { hash,  verify } from "jsr:@felix/bcrypt";
import chalk from "npm:chalk";
import instance_name from "./config.js";
import { gen } from "./codegen.js";
import { DataTypes, Sequelize } from 'sequelize';
import { ban_user_by_uuid, connectedUsers, create_post, create_reply, delete_post, delete_user, get_community_by_name, get_post_by_id, get_posts_from_community, get_replies_from_post_id, get_user_by_name, get_user_by_uuid, is_user_banned, like_post_by_id, like_reply_by_id, userSockets, validate_token } from "./db.ts";



let backgroundTasksStarted = false;
export function startHttpServer({ port } = {}) {
  if (!backgroundTasksStarted) {
    // start background sweeps and hooks once
    // TODO: Implement Supabase paranoid tables

    // ensure at least 5 keys are present: generate up to 5 on startup
    // async function replenishCodes(target = 5) {
    //   try {
    //     const count = await Code.count();
    //     const need = target - count;
    //     if (need > 0) {
    //       console.log(`Generating ${need} code(s) to maintain ${target} available keys`);
    //       for (let i = 0; i < need; i++) {
    //         try {
    //           await gen();
    //         } catch (e) {
    //           console.error('Failed to generate code:', e);
    //         }
    //       }
    //     }
    //   } catch (e) {
    //     console.error('Failed to check code count:', e);
    //   }
    // }

    // initial fill to ensure there are 5 codes
    //  replenishCodes(5).catch((e) => console.error('replenishCodes initial error:', e));

    // whenever a Code is destroyed (used), replenish to keep 5
    // Sequelize.afterDestroy(Code, async (codeInstance, options) => {
    //   console.log('Code used, replenishing keys...');
    //   try {
    //     await replenishCodes(5);
    //   } catch (e) {
    //     console.error('replenishCodes afterDestroy error:', e);
    //   }
    // });

    // periodic check: if less than 5 exist, create enough to make 5
    // setInterval(() => {
    //   replenishCodes(5).catch((e) => console.error('replenishCodes interval error:', e));
    // }, 30 * 1000);

    // TODO: make a callback to alert other users a new post was added
    // Post.addHook('afterCreate', async (post) => {
    //   const author = await User.findByPk(post.userId);
      // for (const [socket, userData] of connectedUsers.entries()) {
      //   if (userData.uuid !== author.uuid) {
      //     try {
      //       socket.send(JSON.stringify({
      //         cmd: "new_post"
      //       }));
      //     } catch { }
      //   }
      // }
    // });
  }

  Deno.serve(async (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const {
        socket,
        response
      } = Deno.upgradeWebSocket(req);
      socket.addEventListener("close", () => {
        connectedUsers.delete(socket);
        userSockets.delete(socket)
      });

      socket.addEventListener("open", () => {
        connectedUsers.set(socket, {
          client: null,
          maelib: undefined,
          libfinite: undefined,
          userId: null,
          deviceId: null,
          currentCommunity: null
        });
        try {
          socket.send(JSON.stringify({
            cmd: "welcome",
            instance_name: instance_name
          }));
        } catch { }
      });

      socket.addEventListener("message", async (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          try {
            socket.send(JSON.stringify({
              error: true,
              code: 400,
              reason: "badJSON"
            }));
          } catch { }
          return;
        }
        switch (data.cmd) {
          case "client_info": {
            if (!data.client || !data.maelib || !data.libfinite) {
              try {
                socket.send(JSON.stringify({
                  error: true,
                  code: 4005,
                  reason: "badRequest"
                }));
              } catch { }
              socket.close(4008)
            }
            const entry = connectedUsers.get(socket) || {};
            const user = userSockets.get(socket);
            // ensure we're on matching maelib and libfinite versions
            if (data.maelib !== "0.2.0" || data.client !== "maelink_gen2" || data.libfinite !== "0.7.3") {
              try {
                socket.send(JSON.stringify({
                  error: true,
                  code: 4001,
                  reason: "oldClient"
                }));
              } catch { }
              socket.close(4001)
            }
            
            entry.client = data.client;
            entry.maelib = data.maelib;
            entry.libfinite = data.libfinite;

            if (!data.user_id || !data.device_id) {
              try {
                socket.send(JSON.stringify({
                  error: true,
                  code: 4000,
                  reason: "noCredientials"
                }));
              } catch { }
              socket.close(4000)
            }

            if (user || userSockets.has(data.user_id)) {
              try {
                socket.send(JSON.stringify({
                  error: true,
                  code: 4002,
                  reason: "connectionExists"
                }));
              } catch { }
              socket.close(4002)
            } else {
              userSockets.set(data.user_id, socket)
            }

            entry.userId = data.user_id
            entry.deviceId = data.device_id
            entry.currentCommunity = data.community || 0;
            connectedUsers.set(socket, entry);
            try {
              socket.send(JSON.stringify({
                error: false,
                code: 200,
                reason: "clientInfoUpdated"
              }));
            } catch { }
            break;
          }
          // register and login stuff are handled by supabase and the tokens
          default:
            try {
              socket.send(JSON.stringify({
                error: true,
                code: 404,
                reason: "notFound"
              }));
            } catch { }
        }
      });

      return response;
    }

    const url = new URL(req.url);

    const CORS_HEADERS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, token",
    };

    const endpoints = {
      home: "/api/feed",
      posts:"/api/posts"
    };

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (req.method === "POST" && url.pathname === endpoints.home) {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      if (!token || !user_id || !device_id) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response("Unauthorized", {
          status: tokenData.status,
          message: tokenData.msg,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);

      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)

      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }


      try {
        const body = await req.json();
        console.log(body);
        if (body.community == null) {
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        } 
        const rawContent = (body && (body.content ?? body.p ?? body.text));
        const content = (rawContent == null) ? '' : String(rawContent).trim();

        // first verify the community exists
        const dest = await get_community_by_name(body.community)

        if (dest.status != 200) {
          return new Response(dest.msg, {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        const post = await create_post(content, user_id, dest.data.id)

        if (post.status != 200 ) {
          return new Response(post.msg, {
            status: post.status,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        return new Response(JSON.stringify({
          success: true
        }), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      } catch {
        return new Response("Bad Request", {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
    } else if (req.method === "GET" && url.pathname === endpoints.home) {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      const community_id = req.headers.get("community_id");
      if (!token || !user_id || !device_id || !community_id ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response(tokenData.msg, {
          status: tokenData.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);

      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)

      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const posts = await get_posts_from_community(community_id)

      if (posts.status != 200) {
        return new Response(posts.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }


      return new Response(
        JSON.stringify({
          posts
        }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    } else if (req.method === "DELETE" && url.pathname === endpoints.posts) {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      const post_id = req.headers.get("post_id");
      if (!token || !user_id || !device_id || !post_id ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response(tokenData.msg, {
          status: tokenData.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);

      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)

      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
      

      const post = await get_post_by_id(post_id, true)
      if (post.status != 200) {
        return new Response(post.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
      
      const isModerator = foundUser.data.is_moderator
      if (post.data.author !== foundUser.data.id && !isModerator) {
        return new Response("Forbidden", {
          status: 403,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      try {
        // TODO: add event to action log
        const ctx = await delete_post(post_id)
        if (post.status != 200) {
          return new Response(post.ctx.msg, {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        return new Response(JSON.stringify({
          success: true
        }), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });

      } catch {
        return new Response("Internal Server Error", {
          status: 500,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
    } else if (req.method === "GET" && url.pathname === endpoints.posts) {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      const post_id = req.headers.get("post_id");
      if (!token || !user_id || !device_id || !post_id ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response(tokenData.msg, {
          status: tokenData.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);

      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)

      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const post = await get_post_by_id(post_id, false)
      if (post.status != 200) {
        return new Response(post.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
    
      const replies = await get_replies_from_post_id(post_id);
      // if no replies do nothing

      return new Response(
        JSON.stringify({
          status: post.status,
          post: post.data,
          replies: replies.data
        }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    } else if (req.method === "GET" && url.pathname === "/api/post/like") {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      const post_id = req.headers.get("post_id");
      if (!token || !user_id || !device_id || !post_id ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response(tokenData.msg, {
          status: tokenData.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);
      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)
      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const post = await like_post_by_id(post_id, user_id)
      if (post.status != 200) {
        return new Response(post.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      return new Response(
        JSON.stringify({
          status: post.status,
          post: post.data
        }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    } else if (req.method === "POST" && url.pathname === "/api/replies") {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      if (!token || !user_id || !device_id) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response("Unauthorized", {
          status: tokenData.status,
          message: tokenData.msg,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);
      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)
      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      try {
        const body = await req.json();
        console.log(body);
        if (body.parent == null) {
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        } 
        const rawContent = (body && (body.content ?? body.p ?? body.text));
        const content = (rawContent == null) ? '' : String(rawContent).trim();

        // first verify the post exists
        const dest = await get_post_by_id(body.parent, false)

        if (dest.status != 200) {
          return new Response(dest.msg, {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        const post = await create_reply(content, user_id, dest.data.id)

        if (post.status != 200 ) {
          return new Response(post.msg, {
            status: post.status,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        return new Response(JSON.stringify({
          success: true
        }), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      } catch {
        return new Response("Bad Request", {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
    } else if (req.method === "GET" && url.pathname === "/api/replies/like") {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      const reply_id = req.headers.get("reply_id");
      if (!token || !user_id || !device_id || !reply_id ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response(tokenData.msg, {
          status: tokenData.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);
      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)
      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const reply = await like_reply_by_id(reply_id, user_id)
      if (reply.status != 200) {
        return new Response(reply.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      return new Response(
        JSON.stringify({
          status: reply.status,
          reply: reply.data
        }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    } else if (req.method === "POST" && url.pathname === "/api/ban") {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      if (!token || !user_id || !device_id ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response(tokenData.msg, {
          status: tokenData.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const foundUser = await get_user_by_uuid(user_id);
      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const banData = await is_user_banned(user_id)
      if (banData.status != 200) {
        return new Response(banData.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
      
      const isModerator = foundUser.data.is_moderator
      if (!isModerator) {
        return new Response("Forbidden", {
          status: 403,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }


      try {
        const body = await req.json();
        if (!body.target) {
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        if (body.target === foundUser.data.username) {
          return new Response("Forbidden", {
            status: 403,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        const target = await get_user_by_name(body.target)
        if (target.status !== 200) {
          return new Response('Bad Request', {
            status: 400,
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'text/plain'
            }
          });
        }

        // if user is already banned, do nothing
        const isBanned = await is_user_banned(target.data.id)
        if (isBanned.status != 200) {
          return new Response(isBanned.msg, {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }

        const until = new Date(body.until)|| null;
        const why = body.reason || null;

        const res = await ban_user_by_uuid(target.data.id, until, why);
        if (res.status != 200) {
          return new Response(res.msg, {
            status: res.status,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/plain"
            }
          });
        }


        console.log(`${foundUser.data.username} banned ${target.data.username} until ${until}`);
        return new Response(JSON.stringify({
          success: true
        }), {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      } catch {
        return new Response('Bad Request', {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
      }

    } else if (req.method === "GET" && url.pathname === "/api/me") {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      if (!token || !user_id || !device_id) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response("Unauthorized", {
          status: tokenData.status,
          message: tokenData.msg,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      const whoIs = req.headers.get("lookup_id") || user_id

      const foundUser = await get_user_by_uuid(whoIs);

      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      return new Response(JSON.stringify({
        status: foundUser.status,
        data: foundUser.data
      }), {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    } else if (req.method === "GET" && url.pathname === "/api/actionlogs") { // TODO: Rewrite this when actionlog is implemented
      // const token = req.headers.get('token');
      // if (!token) return new Response('Unauthorized', {
      //   status: 401,
      //   headers: {
      //     ...CORS_HEADERS,
      //     'Content-Type': 'text/plain'
      //   }
      // });
      // const actor = await User.findOne({
      //   where: {
      //     token
      //   }
      // });
      // if (!actor) return new Response('Unauthorized', {
      //   status: 401,
      //   headers: {
      //     ...CORS_HEADERS,
      //     'Content-Type': 'text/plain'
      //   }
      // });
      // if (!['mod', 'admin', 'sysadmin'].includes(actor.role)) return new Response('Forbidden', {
      //   status: 403,
      //   headers: {
      //     ...CORS_HEADERS,
      //     'Content-Type': 'text/plain'
      //   }
      // });

      // const actionFilter = url.searchParams.get('action') || null;
      // const actorFilter = url.searchParams.get('actor') || null;
      // const targetFilter = url.searchParams.get('target') || null;
      // const since = url.searchParams.get('since') || null;
      // const until = url.searchParams.get('until') || null;
      // const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
      // const page = Math.max(0, Number(url.searchParams.get('page') || 0));
      // const offset = page * limit;

      // try {
      //   const where = {};
      //   const {
      //     Op
      //   } = Sequelize;
      //   if (actionFilter) where.action = actionFilter;
      //   if (since || until) where.created_at = {};
      //   if (since) where.created_at[Op.gte] = new Date(since);
      //   if (until) where.created_at[Op.lte] = new Date(until);

      //   if (actorFilter) {
      //     const aUser = await User.findOne({
      //       where: {
      //         name: actorFilter
      //       }
      //     }) || await User.findOne({
      //       where: {
      //         name: actorFilter.replace(/^@/, '')
      //       }
      //     });
      //     if (!aUser) return new Response(JSON.stringify({
      //       logs: []
      //     }), {
      //       headers: {
      //         ...CORS_HEADERS,
      //         'Content-Type': 'application/json'
      //       }
      //     });
      //     where.actorId = aUser.id;
      //   }
      //   if (targetFilter) {
      //     const tUser = await User.findOne({
      //       where: {
      //         name: targetFilter
      //       }
      //     }) || await User.findOne({
      //       where: {
      //         name: targetFilter.replace(/^@/, '')
      //       }
      //     });
      //     if (!tUser) return new Response(JSON.stringify({
      //       logs: []
      //     }), {
      //       headers: {
      //         ...CORS_HEADERS,
      //         'Content-Type': 'application/json'
      //       }
      //     });
      //     where.targetUserId = tUser.id;
      //   }

      //   const logs = await ActionLog.findAll({
      //     where,
      //     order: [
      //       ['created_at', 'DESC']
      //     ],
      //     limit,
      //     offset
      //   });
      //   const mapped = [];
      //   for (const l of logs) {
      //     const a = l.actorId ? await User.findByPk(l.actorId) : null;
      //     const t = l.targetUserId ? await User.findByPk(l.targetUserId) : null;
      //     mapped.push({
      //       id: l.id,
      //       actor: a ? a.name : null,
      //       target: t ? t.name : null,
      //       action: l.action,
      //       details: l.details,
      //       created_at: l.created_at
      //     });
      //   }
      //   return new Response(JSON.stringify({
      //     logs: mapped
      //   }), {
      //     headers: {
      //       ...CORS_HEADERS,
      //       'Content-Type': 'application/json'
      //     }
      //   });
      // } catch (e) {
      //   console.error('Failed to fetch action logs:', e);
      //   return new Response('Internal Server Error', {
      //     status: 500,
      //     headers: {
      //       ...CORS_HEADERS,
      //       'Content-Type': 'text/plain'
      //     }
      //   });
      // }
    } else if (req.method === 'DELETE' && url.pathname === '/api/account') {
      const token = req.headers.get("token");
      const user_id = req.headers.get("user_id");
      const device_id = req.headers.get("device_id");
      if (!token || !user_id || !device_id) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // validate the token
      const tokenData = await validate_token(token, device_id, user_id);
      if (tokenData.status != 200) {
        return new Response("Unauthorized", {
          status: tokenData.status,
          message: tokenData.msg,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }

      // allow admins to delete other accounts
      const foundUser = await get_user_by_uuid(user_id);

      if (foundUser.status != 200) {
        return new Response(foundUser.msg, {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain"
          }
        });
      }
      
      // TODO: Paranoid deletions

      const res = await delete_user(user_id)

      return new Response(JSON.stringify({
        status: res.status,
        message: res.msg
      }), {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    } 
    // else if (req.method === "GET" && url.pathname === "/api/inbox") {
    //   const token = req.headers.get('token');
    //   if (!token) return new Response('Unauthorized', {
    //     status: 401,
    //     headers: {
    //       ...CORS_HEADERS,
    //       'Content-Type': 'text/plain'
    //     }
    //   });
    //   const actor = await User.findOne({
    //     where: {
    //       token
    //     }
    //   });
    //   if (!actor) return new Response('Unauthorized', {
    //     status: 401,
    //     headers: {
    //       ...CORS_HEADERS,
    //       'Content-Type': 'text/plain'
    //     }
    //   });
    //   const messages = await InboxPost.findAll({
    //     where: {
    //       toUserId: actor.id
    //     },
    //     order: [
    //       ['created_at', 'DESC']
    //     ]
    //   });
    //   return new Response(JSON.stringify({
    //     messages
    //   }), {
    //     headers: {
    //       ...CORS_HEADERS,
    //       'Content-Type': 'application/json'
    //     }
    //   });
    // } else if (req.method === "POST" && url.pathname === "/api/inbox") {
    // const token = req.headers.get('token');
    // if (!token) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    // const sender = await User.findOne({ where: { token } });
    // if (!sender) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    // try {
    // const body = await req.json();
    // const rawTarget = body.to || body.user || body.uuid;
    // const rawContent = body.content || body.text || body.msg;
    // if (!rawTarget || !rawContent) return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    // const content = String(rawContent).trim();
    // if (!content || content.length > 2000) return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    // // find recipient by uuid or name (allow @ prefix)
    // const recipient = await User.findOne({ where: { uuid: rawTarget } })
    //   || await User.findOne({ where: { name: rawTarget } })
    //   || await User.findOne({ where: { name: String(rawTarget).replace(/^@/, '') } });

    // if (!recipient) return new Response('Not Found', { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    // const msg = await InboxPost.create({
    //   content,
    //   timestamp: new Date(),
    //   userId: sender.id,
    //   toUserId: recipient.id
    // });

    // // notify connected recipient sockets
    // for (const [sock, ud] of connectedUsers.entries()) {
    //   try {
    //   if (ud.uuid === recipient.uuid || ud.token === recipient.token) {
    //     sock.send(JSON.stringify({
    //     cmd: 'inbox_new',
    //     message: {
    //       id: msg.id,
    //       from: sender.name,
    //       content: msg.content,
    //       timestamp: msg.timestamp || msg.createdAt
    //     }
    //     }));
    //   }
    //   } catch { }
    // }

    // return new Response(JSON.stringify({ success: true, id: msg.id }), {
    //   headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    // });
    // } catch {
    // return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    // }
    // } else if (req.method === "DELETE" && url.pathname === "/api/inbox") {
    //   const token = req.headers.get('token');
    //   if (!token) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    //   const actor = await User.findOne({ where: { token } });
    //   if (!actor) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    //   const id = url.searchParams.get('id');
    //   if (!id) return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    //   const message = await InboxPost.findOne({ where: { id } });
    //   if (!message) return new Response('Not Found', { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    //   const isModerator = ['mod', 'admin', 'sysadmin'].includes(actor.role);
    //   // allow deletion if actor is sender, recipient, or moderator
    //   if (message.userId !== actor.id && message.toUserId !== actor.id && !isModerator) {
    //   return new Response('Forbidden', { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    //   }

    //   try {
    //   await message.destroy();
    //   return new Response(JSON.stringify({ success: true }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    //   } catch {
    //   return new Response('Internal Server Error', { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    //   }
    // }
  })
};