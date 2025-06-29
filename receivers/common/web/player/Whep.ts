// This file is taken from the whip-whep-js project (https://github.com/medooze/whip-whep-js).
// Changes include porting to TypeScript, removing the use of extensions and ICE trickle features.
//
// Original license:
//
// MIT License
//
// Copyright (c) 2021 medooze
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const logger = window.targetAPI.logger;

async function try_fetch(url: string, method: string, body: string, headers: HeadersInit, retries: number): Promise<Response> {
    for (let i = 0; i < retries; i++) {
        try {
            return await fetch(url, { method, body, headers });
        } catch (error) {
            logger.error(error);
            await new Promise(resolve => setTimeout(resolve, 750));
        }
    }

    throw Error("Failed to fetch");
}

export class WHEPClient extends EventTarget {
    private pc: RTCPeerConnection;
    private candidates: any;
    private endOfcandidates: boolean;
    private onOffer: any;
    private onAnswer: any;
    private resourceURL: URL;
    private eventSource: EventSource;
    // TODO: headers
    // private headers: HeadersInit;

    constructor() {
        super();
        this.candidates = [];
        this.endOfcandidates = false;
        this.pc = null;
        this.resourceURL = null;
        this.eventSource = null;

        this.onOffer = offer => offer;
        this.onAnswer = answer => answer;
    }

    async view(pc: RTCPeerConnection, url: string /*, token?: string*/): Promise<void> {
        if (this.pc)
            throw new Error("Already viewing")

        this.pc = pc;

        // Listen for state change events
        pc.onconnectionstatechange = (event) => {
            switch (pc.connectionState) {
                case "connected":
                    // The connection has become fully connected
                    break;
                case "disconnected":
                case "failed":
                    // One or more transports has terminated unexpectedly or in an error
                    break;
                case "closed":
                    // The connection has been closed
                    break;
            }
        }

        // Listen for candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // Ignore candidates not from the first m line
                if (event.candidate.sdpMLineIndex > 0)
                    // Skip
                    return;
                // Store candidate
                this.candidates.push(event.candidate);
            } else {
                // No more candidates
                this.endOfcandidates = true;
            }
        }

        // Create SDP offer
        const offer = await pc.createOffer();
        offer.sdp = this.onOffer(offer.sdp);
        // Request headers
        const headers = {
            "Content-Type": "application/sdp"
        };

        // Do the post request to the WHEP endpoint with the SDP offer
        const fetched = await try_fetch(url, "POST", offer.sdp, headers, 10);

        if (!fetched.ok)
            throw new Error("Request rejected with status " + fetched.status)
        if (!fetched.headers.get("location"))
            throw new Error("Response missing location header")

        // Get the resource url
        this.resourceURL = new URL(fetched.headers.get("location"), url);

        // Get the links
        const links = {};

        // If the response contained any
        if (fetched.headers.has("link")) {
            // Get all links headers
            const linkHeaders = fetched.headers.get("link").split(/,\s+(?=<)/)

            // For each one
            for (const header of linkHeaders) {
                try {
                    let rel, params = {};
                    // Split in parts
                    const items = header.split(";");
                    // Create url server
                    const url = items[0].trim().replace(/<(.*)>/, "$1").trim();
                    // For each other item
                    for (let i = 1; i < items.length; ++i) {
                        // Split into key/val
                        const subitems = items[i].split(/=(.*)/);
                        // Get key
                        const key = subitems[0].trim();
                        // Unquote value
                        const value = subitems[1]
                            ? subitems[1]
                                .trim()
                                .replaceAll("\"", "")
                                .replaceAll("'", "")
                            : subitems[1];
                        // Check if it is the rel attribute
                        if (key === "rel")
                            // Get rel value
                            rel = value;
                        else
                            // Unquote value and set them
                            params[key] = value
                    }
                    // Ensure it is an ice server
                    if (!rel) {
                        continue;
                    }
                    if (!links[rel]) {
                        links[rel] = [];
                    }
                    // Add to config
                    links[rel].push({ url, params });
                } catch (e) {
                    console.error(e)
                }
            }
        }


        // Get the SDP answer
        const answer = await fetched.text();
        // Set local description
        await pc.setLocalDescription(offer);
        // And set remote description
        await pc.setRemoteDescription({ type: "answer", sdp: this.onAnswer(answer) });
    }

    async stop(): Promise<void> {
        if (!this.pc) {
            // Already stopped
            return
        }

        this.pc.close();
        this.pc = null;

        if (!this.resourceURL) {
            throw new Error("WHEP resource url not available yet");
        }

        const headers = {};
        await fetch(this.resourceURL, {
            method: "DELETE",
            headers
        });
    }
}
