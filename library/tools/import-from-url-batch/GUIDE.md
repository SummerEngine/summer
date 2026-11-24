# summer_import_from_url_batch

Download multiple files from public HTTPS URLs in one operation. Performs a single filesystem scan after all downloads, which is faster than importing one at a time. A video (.mp4, .mov, .webm) is converted to Ogg Theora first and lands at its path with .ogv. Use public HTTPS URLs on port 443. The engine refuses HTTP, local/private addresses and URL credentials with unsafe_url.
