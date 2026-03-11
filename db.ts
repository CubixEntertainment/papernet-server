import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import * as jose from "jsr:@panva/jose";
import * as eddsa from "jsr:@noble/ed25519";
import { DataTypes } from "sequelize";

export let client:SupabaseClient | undefined = undefined

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
    if (bannedUntil < currentTime) {
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

export async function get_post_by_id(post_id:number) {
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