+++
author = "Basil Papadimas"
title = "Real-time Video Streaming with SRT"
date = "2025-09-09"
+++

## The Challenge: Remote Video Streaming Setup

In this article, I'll share a generic setup for reliably streaming video with sub-second latency over the internet. I recently installed surveillance cameras in a remote house that connects to the internet via Starlink. I decided to host the software myself to process the streams, run motion detection, and record automatically, rather than pay a subscription to the camera manufacturer.

## Understanding the Problem

This turned out trickier than I expected! The software I needed was already there, but I faced many different architectural options, and each role in that architecture had multiple candidates. Let me define the problem better: I needed to transport the frames captured by the camera across the internet so my server could actually ingest them. 

## Hardware Limitations and Constraints

I can easily set up RTSP streams into Frigate that perform perfectly through go2rtc, as long as the cameras are in the same local network as the streaming server. However, in this case the only other computer in the Starlink LAN was a Raspberry PI, which doesn't have the hardware I need to run AI models for object detection on the frames. The Raspberry PI 5 doesn't even have the capability to offload transcoding to hardware, so for video I can only forward the format that the cameras themselves produce and stream via RTSP. I'll only use the Raspberry PI (I'll call it "rpi" from here on) to provide a connection to the Starlink LAN from my remote server.

## First Attempt: Tailscale for Remote Network Access

To remotely access the Starlink LAN from my remote server (I'll call it just "server" from here on), I initially chose Tailscale. This is a great choice since it uses the Wireguard (UDP) protocol under the hood and establishes direct (mesh) connections between computers in its virtual network. Through its 4via6 subnet routers, it also allowed me to directly address requests to the cameras from my server, even though the Starlink LAN subnet address space conflicted with my server's LAN (both were using 192.168.1.0/24 addresses, so my server addressed the cameras with IPv6 addresses that the rpi translated back into Starlink LAN IPv4 addresses before passing them to the Starlink router). 

## Tailscale Problems and Performance Issues

However, I quickly ran into problems setting up the cameras into Frigate with IPv6 addresses (go2rtc worked, ONVIF didn't) and I needed a proxy (nginx container that frigate routed through with network_mode) to present IPv4 addresses to frigate that I translated into the real IPv6 addresses before forwarding to Tailscale. After these fixes, I had a working stream in Frigate, but the lag was excessive (10-15 seconds at best), the quality was very low, and it often didn't work at all. In retrospect, I mostly blame this on the architecture I used (RTSP protocol, server making requests to cameras through Tailscale, etc.) and not on Tailscale itself. However, my next step was to manually connect the rpi to the server, because I couldn't know for sure if Tailscale was causing the problem with how it made the connection and routed packets. If I managed the connection myself, I would have a complete end-to-end view.

## Building a Custom Wireguard Tunnel

To create my own tunnel, I decided to use Wireguard, even though I'm aware of protocols like MASQUE which might be even better, because most of my routed traffic would be UDP anyway. Since the Starlink terminal is behind a CGNAT, I couldn't host the wireguard endpoint on the rpi. Instead, I hosted it on the server and had the rpi connect to it. Instead of routing the streams directly from the cameras to the server through wireguard (with iptables on the rpi), I decided to run go2rtc on the rpi to have it pull the streams from the cameras, then have the server directly pull them from go2rtc, which I hoped would be more stable. Unfortunately, I only saw marginal improvement in latency, and the blackout periods where the streams weren't working actually intensified. At this point, I realized that my initial approach needed big changes - either changing the streaming protocol or changing the architecture so that instead of a round trip (RTSP streams require round trips!!!) the frames travel one way from the rpi to the server. I ended up doing both.

## Experimenting with RTMP and switching to SRT

Initially, I tried using RTMP as the transfer protocol for the connection between the rpi and the server, with go2rtc on the pi publishing to mediamtx on the server. This worked relatively well at the start of sessions, but it quickly drifted behind the source (I suspect too many packets were lost in transit but it kept waiting for them) and eventually stopped working altogether. After trying different ffmpeg parameters and lower resolutions/framerates, I gave up on RTMP (or trying RTMP over UDP) and decided to go straight to SRT, which ended up working with very little latency and jitter (I also tried setting up WebRTC for this link, but it was too complicated, and I preferred to keep it simple). Instead of go2rtc, I am actually running mediamtx on the client-side too to publish the SRT stream.

## Architecture Diagram

<svg width="100%" height="500" viewBox="0 0 900 500" xmlns="http://www.w3.org/2000/svg" style="max-width: 100%; height: auto;">
  <!-- Remote House -->
  <rect x="50" y="50" width="250" height="400" fill="#3a3a3a" stroke="#888" stroke-width="2" rx="10"/>
  <text x="175" y="35" text-anchor="middle" font-family="Arial" font-size="16" font-weight="bold" fill="#fff">Remote House</text>
  
  <!-- Cameras -->
  <rect x="80" y="98" width="70" height="45" fill="#4CAF50" stroke="#888" stroke-width="1" rx="5"/>
  <text x="115" y="126" text-anchor="middle" font-family="Arial" font-size="11" fill="#fff">Camera 1</text>
  
  <rect x="200" y="98" width="70" height="45" fill="#4CAF50" stroke="#888" stroke-width="1" rx="5"/>
  <text x="235" y="126" text-anchor="middle" font-family="Arial" font-size="11" fill="#fff">Camera 2</text>
  
  <!-- Raspberry Pi -->
  <rect x="125" y="180" width="100" height="60" fill="#FF9800" stroke="#888" stroke-width="2" rx="5"/>
  <text x="175" y="205" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="#fff">Raspberry Pi</text>
  <text x="175" y="225" text-anchor="middle" font-family="Arial" font-size="12" fill="#fff">mediamtx</text>
  
  <!-- Wireguard Client -->
  <rect x="125" y="283" width="100" height="35" fill="#8E24AA" stroke="#888" stroke-width="1" rx="5"/>
  <text x="175" y="305" text-anchor="middle" font-family="Arial" font-size="12" fill="white">Wireguard</text>
  
  <!-- Starlink -->
  <ellipse cx="175" cy="390" rx="50" ry="25" fill="#0066CC" stroke="#888" stroke-width="2"/>
  <text x="175" y="396" text-anchor="middle" font-family="Arial" font-size="12" fill="white">Starlink</text>
  
  <!-- Internet Connection (compact design) -->
  <rect x="380" y="370" width="140" height="40" fill="#42A5F5" stroke="#888" stroke-width="2" rx="20"/>
  <text x="450" y="394" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="#fff">Internet</text>
  
  <!-- Server -->
  <rect x="600" y="50" width="250" height="400" fill="#3a3a3a" stroke="#888" stroke-width="2" rx="10"/>
  <text x="725" y="35" text-anchor="middle" font-family="Arial" font-size="16" font-weight="bold" fill="#fff">Server</text>
  
  <!-- Home Assistant -->
  <rect x="625" y="98" width="200" height="45" fill="#41BDF5" stroke="#888" stroke-width="1" rx="5"/>
  <text x="725" y="126" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="white">Home Assistant</text>
  
  <!-- Frigate + go2rtc -->
  <rect x="625" y="175" width="200" height="70" fill="#2196F3" stroke="#888" stroke-width="1" rx="5"/>
  <text x="725" y="205" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="white">Frigate</text>
  <text x="725" y="225" text-anchor="middle" font-family="Arial" font-size="12" fill="white">+ go2rtc</text>
  
  <!-- mediamtx Server -->
  <rect x="625" y="278" width="200" height="45" fill="#4CAF50" stroke="#888" stroke-width="1" rx="5"/>
  <text x="725" y="306" text-anchor="middle" font-family="Arial" font-size="14" fill="white">mediamtx</text>
  
  <!-- Wireguard Server (adjusted for perfect horizontal alignment) -->
  <rect x="625" y="372" width="200" height="36" fill="#8E24AA" stroke="#888" stroke-width="1" rx="5"/>
  <text x="725" y="395" text-anchor="middle" font-family="Arial" font-size="12" fill="white">Wireguard Server</text>
  
  <!-- Connections -->
  <!-- Cameras to Pi -->
  <line x1="115" y1="143" x2="155" y2="180" stroke="#888" stroke-width="2" marker-end="url(#arrowhead)"/>
  <line x1="235" y1="143" x2="195" y2="180" stroke="#888" stroke-width="2" marker-end="url(#arrowhead)"/>
  <text x="140" y="162" font-family="Arial" font-size="10" fill="#aaa">RTSP</text>
  
  <!-- Pi to Wireguard -->
  <line x1="175" y1="240" x2="175" y2="283" stroke="#888" stroke-width="2" marker-end="url(#arrowhead)"/>
  <text x="185" y="262" font-family="Arial" font-size="10" fill="#FF5722">SRT</text>
  
  <!-- Wireguard to Starlink -->
  <line x1="175" y1="318" x2="175" y2="365" stroke="#888" stroke-width="2" marker-end="url(#arrowhead)"/>
  
  <!-- Starlink through Internet to Server (single integrated flow, perfectly horizontal) -->
  <line x1="225" y1="390" x2="380" y2="390" stroke="#888" stroke-width="3" marker-end="url(#arrowhead)"/>
  <line x1="520" y1="390" x2="625" y2="390" stroke="#888" stroke-width="3" marker-end="url(#arrowhead)"/>
  
  <!-- Wireguard Server to mediamtx -->
  <line x1="725" y1="372" x2="725" y2="323" stroke="#888" stroke-width="2" marker-end="url(#arrowhead)"/>
  <text x="735" y="348" font-family="Arial" font-size="10" fill="#FF5722">SRT</text>
  
  <!-- mediamtx to Frigate -->
  <line x1="725" y1="278" x2="725" y2="245" stroke="#888" stroke-width="2" marker-end="url(#arrowhead)"/>
  
  <!-- Frigate to Home Assistant -->
  <line x1="725" y1="175" x2="725" y2="143" stroke="#888" stroke-width="2" marker-end="url(#arrowhead)"/>
  
  <!-- Arrow marker definition -->
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#888"/>
    </marker>
  </defs>
</svg>

## Wireguard Configuration
Finally, noting that server-side, wg-easy, frigate and mediamtx all run as docker containers that share the same network (subnet 10.42.42.0/24), with static IP's: 10.42.42.42 (wg-easy), 10.42.42.43 (frigate), 10.42.42.253 (mediamtx), you might find the following hook / routing table helpful. Client-side, having these different addresses lets the rpi send different packets to different parts of the stack, as well as let me connect to services directly inside the containers from my laptop, for debugging.

```
PostUp = nft add table inet wg_table; \
  nft add chain inet wg_table prerouting { type nat hook prerouting priority -100 \; }; \
  nft add chain inet wg_table postrouting { type nat hook postrouting priority 100 \; }; \
  nft add rule inet wg_table postrouting ip saddr 10.8.0.0/24 oifname eth0 masquerade; \
  nft add rule inet wg_table postrouting ip6 saddr fdcc:ad94:bacf:61a4::cafe:0/112 oifname eth0 masquerade; \
  nft add rule inet wg_table prerouting ip daddr 10.8.0.1 dnat to 10.42.42.1; \
  nft add rule inet wg_table prerouting ip6 daddr fdcc:ad94:bacf:61a4::cafe:1 dnat to fdcc:ad94:bacf:61a3::1; \
  nft add rule inet wg_table prerouting ip daddr 10.8.0.253 dnat to 10.42.42.253; \
  nft add chain inet wg_table input { type filter hook input priority 0 \; policy accept \; }; \
  nft add rule inet wg_table input udp dport 51820 accept; \
  nft add rule inet wg_table input tcp dport 51821 accept; \
  nft add chain inet wg_table forward { type filter hook forward priority 0 \; policy accept \; }; \
  nft add rule inet wg_table forward iifname "wg0" accept; \
  nft add rule inet wg_table forward oifname "wg0" accept;
```