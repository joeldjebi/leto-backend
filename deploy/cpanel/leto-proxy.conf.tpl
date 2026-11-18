# LETO — relais Apache vers l'API NestJS (127.0.0.1:__PORT__) + temps réel (WebSocket)
# Inclus par cPanel dans l'hôte virtuel de api.leto.performx.online (conservé lors des mises à jour cPanel)
ProxyRequests Off
ProxyPreserveHost On
ProxyTimeout 120
RequestHeader set X-Forwarded-Proto "__PROTO__"

# Laisser cPanel/AutoSSL répondre aux validations de certificat
ProxyPass /.well-known !

# WebSocket (positions des livreurs, statuts, propositions de prix)
RewriteEngine On
RewriteCond %{REQUEST_URI} !^/\.well-known/
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule ^/?(.*) ws://127.0.0.1:__PORT__/$1 [P,L]

ProxyPass        / http://127.0.0.1:__PORT__/
ProxyPassReverse / http://127.0.0.1:__PORT__/

# Photos : 5 Mo max côté API
LimitRequestBody 6291456
# APK de l'app (back-office › Landing page) : jusqu'à 200 Mo, uniquement sur cette adresse
<Location "/admin/landing/apk">
    LimitRequestBody 209715200
</Location>
