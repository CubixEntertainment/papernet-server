// deno-lint-ignore-file
import { User, Post, Code, ActionLog, InboxPost } from './database/tables.js';
import { hash,  verify } from "jsr:@felix/bcrypt";
import chalk from "npm:chalk";
import instance_name from "./config.js";
import { gen } from "./codegen.js";
import { Sequelize } from 'sequelize';
import { create_post, delete_post, get_community_by_name, get_post_by_id, get_posts_from_community, get_user_by_uuid, is_user_banned, validate_token } from "./db.ts";

const connectedUsers = new Map();
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
    //   for (const [socket, userData] of connectedUsers.entries()) {
    //     if (userData.uuid !== author.uuid) {
    //       try {
    //         socket.send(JSON.stringify({
    //           cmd: "new_post"
    //         }));
    //       } catch { }
    //     }
    //   }
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
      });

      socket.addEventListener("open", () => {
        connectedUsers.set(socket, {
          user: null,
          token: null,
          uuid: null,
          client: null
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
            if (!data.client) {
              try {
                socket.send(JSON.stringify({
                  error: true,
                  code: 400,
                  reason: "badRequest"
                }));
              } catch { }
            }
            const entry = connectedUsers.get(socket) || {};
            entry.client = data.client;
            entry.cver = data.version || "unknown";
            entry.token = data.token || "";
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

    // TODO: This should be a global where each endpoint is a relative community
    const endpoints = {
      home: "/api/feed"
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
    } else if (req.method === "DELETE" && url.pathname === "/api/post") {
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
      

      const post = await get_post_by_id(post_id)
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
    } else if (req.method === "POST" && url.pathname === "/api/ban") {
      const token = req.headers.get('token');
      if (!token) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const actor = await User.findOne({
        where: {
          token
        }
      });
      if (!actor) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      if (!['mod', 'admin', 'sysadmin'].includes(actor.role)) return new Response('Forbidden', {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      try {
        const body = await req.json();
        const targetName = body.user || body.name || body.uuid;
        if (!targetName) return new Response('Bad Request', {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        const until = body.until || null;
        const days = body.days || null;
        const where = (body.uuid) ? {
          uuid: body.uuid
        } : {
          name: targetName
        };
        const target = await User.findOne({
          where
        });
        if (!target) return new Response('Not Found', {
          status: 404,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        if (target.role === 'sysadmin' && actor.role !== 'sysadmin') return new Response('Forbidden', {
          status: 403,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        target.banned = true;
        if (until) target.banned_until = new Date(until);
        else if (days) target.banned_until = new Date(Date.now() + (Number(days) * 24 * 3600 * 1000));
        else target.banned_until = null;
        await target.save();
        console.log(`${actor.name} banned ${target.name} until ${target.banned_until}`);
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
    } else if (req.method === "POST" && url.pathname === "/api/permissions") {
      const token = req.headers.get('token');
      if (!token) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const actor = await User.findOne({
        where: {
          token
        }
      });
      if (!actor) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      if (!['admin', 'sysadmin'].includes(actor.role)) return new Response('Forbidden', {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      try {
        const body = await req.json();
        const targetName = body.user || body.name || body.uuid;
        const role = body.role;
        if (!targetName || !role) return new Response('Bad Request', {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        if (!['user', 'mod', 'admin', 'sysadmin'].includes(role)) return new Response('Bad Request', {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        const where = (body.uuid) ? {
          uuid: body.uuid
        } : {
          name: targetName
        };
        const target = await User.findOne({
          where
        });
        if (!target) return new Response('Not Found', {
          status: 404,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        if (target.role === 'sysadmin' && actor.role !== 'sysadmin') return new Response('Forbidden', {
          status: 403,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        if (role === 'sysadmin' && actor.role !== 'sysadmin') return new Response('Forbidden', {
          status: 403,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
        target.role = role;
        await target.save();
        console.log(`${actor.name} set role ${role} for ${target.name}`);
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
      const token = req.headers.get('token');
      if (!token) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const user = await User.findOne({
        where: {
          token
        }
      });
      if (!user) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      return new Response(JSON.stringify({
        name: user.name,
        display_name: user.display_name,
        role: user.role,
        uuid: user.uuid
      }), {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    } else if (req.method === "GET" && url.pathname === "/api/actionlogs") {
      const token = req.headers.get('token');
      if (!token) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const actor = await User.findOne({
        where: {
          token
        }
      });
      if (!actor) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      if (!['mod', 'admin', 'sysadmin'].includes(actor.role)) return new Response('Forbidden', {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });

      const actionFilter = url.searchParams.get('action') || null;
      const actorFilter = url.searchParams.get('actor') || null;
      const targetFilter = url.searchParams.get('target') || null;
      const since = url.searchParams.get('since') || null;
      const until = url.searchParams.get('until') || null;
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
      const page = Math.max(0, Number(url.searchParams.get('page') || 0));
      const offset = page * limit;

      try {
        const where = {};
        const {
          Op
        } = Sequelize;
        if (actionFilter) where.action = actionFilter;
        if (since || until) where.created_at = {};
        if (since) where.created_at[Op.gte] = new Date(since);
        if (until) where.created_at[Op.lte] = new Date(until);

        if (actorFilter) {
          const aUser = await User.findOne({
            where: {
              name: actorFilter
            }
          }) || await User.findOne({
            where: {
              name: actorFilter.replace(/^@/, '')
            }
          });
          if (!aUser) return new Response(JSON.stringify({
            logs: []
          }), {
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'application/json'
            }
          });
          where.actorId = aUser.id;
        }
        if (targetFilter) {
          const tUser = await User.findOne({
            where: {
              name: targetFilter
            }
          }) || await User.findOne({
            where: {
              name: targetFilter.replace(/^@/, '')
            }
          });
          if (!tUser) return new Response(JSON.stringify({
            logs: []
          }), {
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'application/json'
            }
          });
          where.targetUserId = tUser.id;
        }

        const logs = await ActionLog.findAll({
          where,
          order: [
            ['created_at', 'DESC']
          ],
          limit,
          offset
        });
        const mapped = [];
        for (const l of logs) {
          const a = l.actorId ? await User.findByPk(l.actorId) : null;
          const t = l.targetUserId ? await User.findByPk(l.targetUserId) : null;
          mapped.push({
            id: l.id,
            actor: a ? a.name : null,
            target: t ? t.name : null,
            action: l.action,
            details: l.details,
            created_at: l.created_at
          });
        }
        return new Response(JSON.stringify({
          logs: mapped
        }), {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      } catch (e) {
        console.error('Failed to fetch action logs:', e);
        return new Response('Internal Server Error', {
          status: 500,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain'
          }
        });
      }
    } else if (req.method === 'DELETE' && url.pathname === '/api/account') {
      const token = req.headers.get('token');
      if (!token) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const actor = await User.findOne({
        where: {
          token
        }
      });
      if (!actor) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const targetParam = url.searchParams.get('user') || url.searchParams.get('uuid') || null;
      const instant = url.searchParams.get('instant') === 'true';
      if (!targetParam || targetParam === actor.name || targetParam === actor.uuid) {
        actor.deletion_scheduled_at = new Date(Date.now() + (7 * 24 * 3600 * 1000));
        actor.deletion_initiated_by = actor.name;
        await actor.save();
        return new Response(JSON.stringify({
          success: true,
          scheduled: actor.deletion_scheduled_at
        }), {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      }
      const target = await User.findOne({
        where: {
          name: targetParam
        }
      }) || await User.findOne({
        where: {
          uuid: targetParam
        }
      });
      if (!target) return new Response('Not Found', {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      if (!['mod', 'admin', 'sysadmin'].includes(actor.role)) return new Response('Forbidden', {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      if (target.role === 'sysadmin' && actor.role !== 'sysadmin') return new Response('Forbidden', {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      if (instant) {
        target.deleted_at = new Date();
        target.deletion_scheduled_at = null;
        target.deletion_initiated_by = actor.name;
        target.token = null;
        target.pswd = null;
        target.display_name = 'Deleted User';
        target.name = `deleted_${target.uuid}`;
        await target.save();
        try {
          await ActionLog.create({
            actorId: actor.id,
            targetUserId: target.id,
            action: 'delete_account',
            details: JSON.stringify({
              instant: true
            })
          });
        } catch (logErr) {
          console.error('Failed to write action log for instant deletion:', logErr);
        }
        console.log(`${actor.name} instantly deleted account ${target.uuid}`);
        return new Response(JSON.stringify({
          success: true,
          deleted: true
        }), {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      } else {
        target.deletion_scheduled_at = new Date(Date.now() + (7 * 24 * 3600 * 1000));
        target.deletion_initiated_by = actor.name;
        await target.save();
        console.log(`${actor.name} scheduled deletion for ${target.name}`);
        return new Response(JSON.stringify({
          success: true,
          scheduled: target.deletion_scheduled_at
        }), {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      }
    } else if (req.method === "GET" && url.pathname === "/api/inbox") {
      const token = req.headers.get('token');
      if (!token) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const actor = await User.findOne({
        where: {
          token
        }
      });
      if (!actor) return new Response('Unauthorized', {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/plain'
        }
      });
      const messages = await InboxPost.findAll({
        where: {
          toUserId: actor.id
        },
        order: [
          ['created_at', 'DESC']
        ]
      });
      return new Response(JSON.stringify({
        messages
      }), {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    } else if (req.method === "POST" && url.pathname === "/api/inbox") {
    const token = req.headers.get('token');
    if (!token) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    const sender = await User.findOne({ where: { token } });
    if (!sender) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    try {
    const body = await req.json();
    const rawTarget = body.to || body.user || body.uuid;
    const rawContent = body.content || body.text || body.msg;
    if (!rawTarget || !rawContent) return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    const content = String(rawContent).trim();
    if (!content || content.length > 2000) return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    // find recipient by uuid or name (allow @ prefix)
    const recipient = await User.findOne({ where: { uuid: rawTarget } })
      || await User.findOne({ where: { name: rawTarget } })
      || await User.findOne({ where: { name: String(rawTarget).replace(/^@/, '') } });

    if (!recipient) return new Response('Not Found', { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

    const msg = await InboxPost.create({
      content,
      timestamp: new Date(),
      userId: sender.id,
      toUserId: recipient.id
    });

    // notify connected recipient sockets
    for (const [sock, ud] of connectedUsers.entries()) {
      try {
      if (ud.uuid === recipient.uuid || ud.token === recipient.token) {
        sock.send(JSON.stringify({
        cmd: 'inbox_new',
        message: {
          id: msg.id,
          from: sender.name,
          content: msg.content,
          timestamp: msg.timestamp || msg.createdAt
        }
        }));
      }
      } catch { }
    }

    return new Response(JSON.stringify({ success: true, id: msg.id }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
    } catch {
    return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    }
    } else if (req.method === "DELETE" && url.pathname === "/api/inbox") {
      const token = req.headers.get('token');
      if (!token) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
      const actor = await User.findOne({ where: { token } });
      if (!actor) return new Response('Unauthorized', { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

      const id = url.searchParams.get('id');
      if (!id) return new Response('Bad Request', { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

      const message = await InboxPost.findOne({ where: { id } });
      if (!message) return new Response('Not Found', { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });

      const isModerator = ['mod', 'admin', 'sysadmin'].includes(actor.role);
      // allow deletion if actor is sender, recipient, or moderator
      if (message.userId !== actor.id && message.toUserId !== actor.id && !isModerator) {
      return new Response('Forbidden', { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
      }

      try {
      await message.destroy();
      return new Response(JSON.stringify({ success: true }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      } catch {
      return new Response('Internal Server Error', { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
      }
    }
  })
};