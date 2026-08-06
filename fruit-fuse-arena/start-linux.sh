#!/usr/bin/env sh
set -eu
printf '%s\n' 'Starting Fruit Fuse Arena at http://localhost:3000'
exec node server.js
