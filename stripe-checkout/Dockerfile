FROM denoland/deno:1.40.3

EXPOSE 8000

WORKDIR /app

USER deno

COPY mod.ts /app/mod.ts

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "mod.ts"]
