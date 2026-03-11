import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import * as jose from "jsr:@panva/jose";
import * as eddsa from "jsr:@noble/ed25519";
import { DataTypes } from "sequelize";

export let client:SupabaseClient | undefined = undefined
export const connectedUsers = new Map();
export const userSockets = new Map();

async function initalizeSupabase() {
    const url = Deno.env.get("PROJECT_URL")
    const key = Deno.env.get("SERVICE_KEY") // private service role key
    if (url == undefined || key == undefined) {
        console.log("A key is missing.")
    } else {
        const supabase = await createClient(url!, key!)
    
        if (supabase) {
            client = supabase
        } else {
            console.log("Something went wrong")
        }
    }
}

async function validateKey(key:string) {
    // create a temporary fake signature
    const msg = new Uint8Array([0]);
    const sig = new Uint8Array(64);
    let str = key.replace("-----BEGIN PUBLIC KEY-----", "")
    str = str.replace("-----END PUBLIC KEY-----", "")


    // convert the key to bytes
    const bytes = Uint8Array.from(atob(str), c => c.charCodeAt(0));

    try {
        await eddsa.verifyAsync(sig, msg, bytes);
        return true;
    } catch {
        return false;
    }
}

export async function validate_token(token:string, device_id: string, user_id:string | undefined = undefined) {
    if (client == undefined) {
        await initalizeSupabase()
        if (client == undefined) {
            console.error("Server Side authentication failed.")
            return {
                status: 501,
                msg: "Server Side authentication failed.",
            }
        }
    }

    const entry = userSockets.has(user_id)
    console.log(entry)
    if (!entry) {
        console.log("Unauthenicated user attempting to connect is not permitted")
        return {
            status: 404,
            msg: "Unauthenticated."
        }
    }

    const { data: dev, error: err } = await client
    .schema('infinite')
    .from('devices')
    .select()
    .eq('device_id', device_id)

    if (err) {
        console.log("something went wrong")
        return {
            status: 404,
            msg: err.message,
        }
    }

    if (dev.length <= 0) {
        console.log("Invalid device id")
        return {
            status: 404,
            msg: "Invalid device id",
        }
    }

    // token is the jwt token
    const algo = 'EdDSA' // this is the algo the token uses
    const testKey = dev[0].device_key // the public key

    try {
        const pubkey = await jose.importSPKI(testKey, algo)
        const { payload } = await jose.jwtVerify(token, pubkey)

        // verify we are who we say we are
        if (payload.device_id != device_id) {
            console.log("Device ID "+payload.device_id+" does not match provided id "+ device_id)
            return {
                status: 404,
                msg: "Invalid device id",
            }
        }

        if (user_id != undefined) {
            if (payload.user_id != user_id) {
                console.log("User ID "+payload.user_id+" does not match provided id "+ user_id)
                return {
                    status: 404,
                    msg: "Invalid user id",
                }
            }
        }

        // we should also reject the JWT if it was made more than an hour ago
        const eat = Math.round(Date.now() / 1000) - 3600;
        if (payload.iat != undefined && payload.iat < eat ) {
            console.log("Le old")
            console.log(eat, payload.iat)
            return {
                status: 404,
                msg: "Provided token has expired.",
            }
        }        
        
        return {
            status: 200,
            msg: "Success",
            data: payload
        }
    } catch {
        console.log("Invalid token")
        return {
            status: 404,
            msg: "Invalid token",
        }
    }
}

export async function get_user_by_uuid(user_id:string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('public')
    .from('users')
    .select()
    .eq('id', user_id)

    if (error) {
        console.log("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    // return a banned message 

    return {
        status: 200,
        msg: "Success",
        data: data[0]
    }
}

export async function get_user_by_name(name:string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('public')
    .from('users')
    .select()
    .eq('username', name)

    if (error) {
        console.log("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    // return a banned message 

    return {
        status: 200,
        msg: "Success",
        data: data[0]
    }
}

export async function is_user_banned(user_id:string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('public')
    .from('bans')
    .select()
    .eq('user', user_id)

    if (error) {
        console.log("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    if (data.length == 0) {
        return {
            status: 200,
            msg: "User is not banned"
        }
    }

    const bannedUntil = new Date(data[0].banned_until)
    const currentTime = new Date(Date.now())
    if (bannedUntil < currentTime && bannedUntil != null) {
        return {
            status: 200,
            msg: "User is not banned"
        }
    }

    // return a banned message 
    return {
        status: 401,
        msg: "User is banned",
        data: data[0]
    }
}

export async function ban_user_by_uuid(user_id:string, until:Date, reason:string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('public')
    .from('bans')
    .insert({
        user: user_id,
        reason,
        banned_until: until
    })
    .select()

    if (error) {
        console.log("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    // TODO: send an email to the target

    return {
        status: 200,
        msg: "Success",
        data
    }
}

export async function delete_user(user_id:string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { error } = await client
    .schema('public')
    .from('users')
    .delete()
    .eq('id', user_id)

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    return {
        status: 200,
        msg: "Success"
    }
}

export async function get_community_by_name(name: string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('papernet')
    .from('communities')
    .select()
    .eq('name', name)

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    if (data.length == 0) {
        return {
            status: 404,
            msg: "No community named \'"+name+"\' found."
        }
    }

    return {
        status: 200,
        msg: "Success",
        data: data[0]
    }
}

export async function create_post(content:string, user_id: string, community_id: number) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    if (content.length == 0 || content.length > 256) {
        return {
            status: 401,
            msg: content.length == 0 ? "Invalid post data" : "Post is too long"
        } 
    }

    const { data, error } = await client
    .schema('papernet')
    .from('posts')
    .insert({
        content,
        author: user_id,
        community: community_id,
    })
    .select()

    if (error) {
        console.warn("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    for (const [socket, userData] of connectedUsers.entries()) {
        if (userData.userId !== user_id && userData.currentCommunity == community_id) {
          try {
            socket.send(JSON.stringify({
              cmd: "new_post"
            }));
          } catch { 
            console.log("unable to send msg to ")
          }
        }
      }

    return {
        status: 200,
        msg: "Success",
        data: data[0]
    }

}

export async function get_posts_from_community(community_id:number) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('papernet')
    .from('posts')
    .select()
    .eq('community', community_id)
    .order('id', { ascending: false })

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    if (data.length == 0) {
        return {
            status: 404,
            msg: "No posts for community found."
        }
    }

    return {
        status: 200,
        msg: "Success",
        data: data
    }
}

export async function get_post_by_id(post_id:number, isLookup:boolean) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('papernet')
    .from('posts')
    .select()
    .eq('id', post_id)

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    if (data.length == 0) {
        return {
            status: 404,
            msg: "Post not found."
        }
    }

    let returnValue = data[0]

    if (!isLookup) {
        const { data, error } = await client
        .schema('papernet')
        .from('posts')
        .update({
            views: returnValue.views + 1
        })
        .eq('id', post_id)
        .select()

        if (error) {
            console.error("something went wrong")
            return {
                status: 404,
                msg: error.message,
            }
        }
        returnValue = data[0]
    }

    return {
        status: 200,
        msg: "Success",
        data: returnValue
    }
}

export async function like_post_by_id(post_id:number, user_id:string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data: lookup, error:err } = await client
    .schema('papernet')
    .from('posts')
    .select()
    .eq('id', post_id)

    if (err) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: err.message,
        }
    }

    if (lookup.length == 0) {
        return {
            status: 404,
            msg: "Post not found."
        }
    }

    // ensure we havent liked this post yet
    const { data: lookup2, error:err2 } = await client
    .schema('papernet')
    .from('likes')
    .select()
    .eq('liked_post', post_id)
    .eq('user', user_id)

    if (err2) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: err2.message,
        }
    }

    let change = 1

    if (lookup2.length > 0) {
        console.log("Post already loved")
        change = -1

        // remove our love 
        const { error:err2 } = await client
        .schema('papernet')
        .from('likes')
        .delete()
        .eq('liked_post', post_id)
        .eq('user', user_id)

        if (err2) {
            console.error("something went wrong")
            return {
                status: 404,
                msg: err2.message,
            }
        }
    } else {
        const { data, error } = await client
        .schema('papernet')
        .from('likes')
        .insert({
            user: user_id,
            liked_post: post_id
        })
        .eq('liked_post', post_id)
        .eq('user', user_id)

        if (error) {
            console.error("something went wrong")
            return {
                status: 404,
                msg: error.message,
            }
        }
    }

    const { data, error } = await client
    .schema('papernet')
    .from('posts')
    .update({
        loves: lookup[0].loves + change
    })
    .eq('id', post_id)
    .select()

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    return {
        status: 200,
        msg: "Success",
        data: data[0]
    }
}

export async function create_reply(content:string, user_id: string, post_id: number) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    if (content.length == 0 || content.length > 256) {
        return {
            status: 401,
            msg: content.length == 0 ? "Invalid reply data" : "Reply is too long"
        } 
    }

    const { data, error } = await client
    .schema('papernet')
    .from('replies')
    .insert({
        content,
        author: user_id,
        parent: post_id,
    })
    .select()

    if (error) {
        console.warn("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    return {
        status: 200,
        msg: "Success",
        data: data[0]
    }

}

export async function get_replies_from_post_id(post_id:number) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data, error } = await client
    .schema('papernet')
    .from('replies')
    .select()
    .eq('parent', post_id)

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    if (data.length == 0) {
        console.log("No replies found")
        return {
            status: 404,
            msg: "No replies found.",
            data: ""
        }
    }

    console.log(data)

    return {
        status: 200,
        msg: "Success",
        data
    }
}

export async function like_reply_by_id(reply_id:number, user_id:string) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { data: lookup, error:err } = await client
    .schema('papernet')
    .from('replies')
    .select()
    .eq('id', reply_id)

    if (err) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: err.message,
        }
    }

    if (lookup.length == 0) {
        return {
            status: 404,
            msg: "Reply not found."
        }
    }

    // ensure we havent liked this post yet
    const { data: lookup2, error:err2 } = await client
    .schema('papernet')
    .from('likes')
    .select()
    .eq('liked_reply', reply_id)
    .eq('user', user_id)

    if (err2) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: err2.message,
        }
    }

    let change = 1

    if (lookup2.length > 0) {
        console.log("Post already loved")
        change = -1

        // remove our love 
        const { error:err2 } = await client
        .schema('papernet')
        .from('likes')
        .delete()
        .eq('liked_reply', reply_id)
        .eq('user', user_id)

        if (err2) {
            console.error("something went wrong")
            return {
                status: 404,
                msg: err2.message,
            }
        }
    } else {
        const { error: err2 } = await client
        .schema('papernet')
        .from('likes')
        .insert({
            user: user_id,
            liked_reply: reply_id
        })
        .eq('liked_reply', reply_id)
        .eq('user', user_id)

        if (err2) {
            console.error("something went wrong")
            return {
                status: 404,
                msg: err2.message,
            }
        }
    }

    const { data, error } = await client
    .schema('papernet')
    .from('replies')
    .update({
        loves: lookup[0].loves + change
    })
    .eq('id', reply_id)
    .select()

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    return {
        status: 200,
        msg: "Success",
        data: data[0]
    }
}

export async function delete_post(post_id:number) {
    if (client == undefined) {
        return {
            status: 401,
            msg: "Cannot perform action on uninitialized client.",
        }
    }

    const { error } = await client
    .schema('papernet')
    .from('posts')
    .delete()
    .eq('id', post_id)

    if (error) {
        console.error("something went wrong")
        return {
            status: 404,
            msg: error.message,
        }
    }

    return {
        status: 200,
        msg: "Success"
    }
}