# Lecteurs compatibles BluOS

**Connecteur non officiel, sans lien avec Lenbrook (Bluesound, NAD) ni avec
les autres marques.** Il fait entrer dans Gladys les lecteurs réseau qui
fonctionnent avec **BluOS** : Bluesound Node, Powernode, Pulse, Flex,
soundbars, streamers et amplis NAD (C658, M10, CI580…), et les autres
appareils pilotés par l'application BluOS Controller. Tout passe par l'API
locale des lecteurs, sur votre réseau : ni compte, ni cloud.

**Testeurs recherchés** : cette première version a été écrite sans lecteur
sous la main, d'après la documentation officielle de l'API BluOS, la
bibliothèque de l'intégration Home Assistant et des réponses enregistrées
sur de vrais lecteurs NAD et Bluesound. Elle a été testée contre des lecteurs
simulés. Dites-nous sur le forum ce qui marche sur votre modèle, et ce qui ne
marche pas.

## Ce que vous obtenez

| Surface                     | Contenu                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un appareil par **lecteur** | lecture, pause, précédent, suivant, volume (0-100), état de lecture, sourdine, source (les entrées et les préréglages du lecteur), titre, artiste, album, groupe, et la fonction « notification » des enceintes de Gladys  |
| Déclencheurs de scène       | **la lecture a changé** (en lecture, en pause, arrêté), **la source a changé** (entrée, préréglage ou service ; filtre par type d'entrée : optique, HDMI ARC, Bluetooth…), **nouveau morceau**                             |
| Actions de scène            | **lecture** (lecture, pause, lecture/pause, arrêt, suivant, précédent), **jouer un préréglage**, **changer de source**, **jouer un son ou un flux**, **rejoindre un groupe**, **quitter son groupe**, **lecture en cours** |
| Boutons de la configuration | **Tester les lecteurs**, **Lister les sources et préréglages** d'un lecteur                                                                                                                                                |

Les lecteurs sont suivis **en direct** : Gladys garde une requête ouverte
sur chaque lecteur (le « long polling » de l'API BluOS), qui répond dès que
quelque chose change. Un changement fait dans l'application BluOS, à la
télécommande ou sur le lecteur arrive donc dans Gladys en une seconde, sans
interroger le lecteur en boucle.

## Mise en route

1. Installez l'intégration et ouvrez **Découverte** : les lecteurs qui
   répondent sur votre réseau sont listés (Gladys les cherche en mDNS, comme
   l'application BluOS). Ajoutez les vôtres.
2. Un lecteur manque ? Son adresse va dans **Adresses des lecteurs** (une IP
   ou un nom d'hôte, plusieurs séparées par des virgules), puis relancez la
   recherche. Le port est 11000 ; les zones 2, 3 et 4 d'un lecteur multizone
   (NAD CI580) sont `adresse:11010`, `:11020`, `:11030`. Donnez une adresse
   fixe à vos lecteurs dans votre box : un lecteur qui a changé d'adresse est
   retrouvé par une nouvelle recherche dans Découverte.
3. Sur un tableau de bord, la boîte **Musique** de Gladys pilote un lecteur
   (lecture, pause, suivant, précédent, volume), comme un Sonos.

## Les notifications de Gladys

L'action de scène **Jouer une notification** de Gladys (la synthèse vocale,
qui passe par Gladys Plus) fonctionne sur un lecteur BluOS : choisissez-le
dans la liste. Le lecteur joue le message, puis **reprend ce qu'il jouait**
quand l'API le permet :

- la file de lecture reprend au morceau et à la seconde où elle en était ;
- une entrée (optique, HDMI ARC, Bluetooth…) est resélectionnée ;
- une radio de vos **préréglages** est relancée.

Une radio hors des préréglages, Spotify Connect ou AirPlay ne peuvent pas
être relancés par l'API : le lecteur reste alors arrêté après le message. Si
vous changez vous-même de source pendant le message, rien n'est relancé.

Gladys ne transmet pas encore le volume choisi dans cette action aux
intégrations externes : réglez plutôt **Volume des annonces** dans la
configuration (0 = volume actuel inchangé) ; le volume d'avant revient après
le message. Un lecteur dans un groupe joue le message sur tout le groupe.

## Scènes

- **La lecture a changé** : un lecteur (ou aucun pour tous), et
  éventuellement le nouvel état (`playing`, `paused`, `stopped`). Variables :
  le nom du lecteur, le nouvel état et le précédent, la source, le titre,
  l'artiste, l'album et un résumé sur une ligne.
- **La source a changé** : filtres sur le type de source (une entrée, un
  préréglage, un service de streaming) et sur le type d'entrée (optique,
  analogique, coaxiale, Bluetooth, HDMI ARC / eARC, phono…). Par exemple :
  « quand la TV passe sur l'entrée HDMI ARC, baisser les lumières ».
- **Nouveau morceau** : ce que joue un lecteur en lecture a changé sur la
  même source.
- **Lecture** : lecture, pause, lecture/pause, arrêt, morceau suivant ou
  précédent. Sur une radio, « suivant » ne marche que si le service le
  permet (Radio Paradise, Slacker…).
- **Jouer un préréglage** : son numéro (`3`) ou son nom (`FIP`).
- **Changer de source** : le nom d'une entrée (`HDMI ARC`), un mot courant
  (`optique`, `TV`, `HDMI`, `Bluetooth`, `analogique`, `aux`, `phono`,
  `vinyle`, `optique 2` pour la deuxième) ou un préréglage (numéro ou nom).
  Le bouton **Lister les sources et préréglages** montre ce qu'un lecteur
  propose.
- **Jouer un son ou un flux** : une adresse `http://` ou `https://` (un
  carillon sur votre NAS, une webradio), un volume facultatif, et **Reprendre
  ensuite** comme pour les notifications.
- **Rejoindre un groupe** / **Quitter son groupe** : le lecteur à ajouter et
  le lecteur principal du groupe ; un lecteur principal qui quitte son
  groupe laisse les autres groupés ensemble.
- **Lecture en cours** donne `online`, `playing`, `state`, `title`,
  `artist`, `album`, `summary`, `source`, `volume`, `muted`, `group` pour un
  message ou une condition. Les actions suivantes de la scène les trouvent
  dans leur liste de variables (écrites `{{<étape>.<action>.<clé>}}`, par
  exemple `{{0.0.summary}}` quand cette action est la première de la scène).

Les changements faits depuis Gladys (une commande, une scène, une
notification) ne déclenchent aucun déclencheur de l'intégration : une scène
ne peut jamais boucler à travers le lecteur. L'action générique **Contrôler
un appareil** pilote aussi la lecture, le volume et la source. **Sourdine**
est affichée par Gladys comme un bouton : chaque appui active ou coupe la
sourdine.

## Bon à savoir

- Le volume d'un appareil est celui de ce lecteur seul, même s'il mène un
  groupe (comme une pièce) ; un lecteur à volume fixe (réglé dans
  l'application BluOS) n'a pas de volume dans Gladys.
- Le lecteur secondaire d'un groupe joue ce que joue le principal : son
  titre, sa source et son état sont ceux du groupe.
- Gladys envoie au plus trois requêtes à la fois à un lecteur (ses deux
  requêtes de suivi et une commande), et jamais deux fois la même en moins
  d'une seconde, comme l'exige l'API BluOS.
- La liste des sources se met à jour quand vous modifiez les préréglages dans
  l'application BluOS (quelques secondes plus tard).

## Dépannage

- **Aucun lecteur dans Découverte** : la recherche demande un réseau qui
  laisse passer le multicast (pas de VLAN entre Gladys et le lecteur) ;
  saisissez plutôt l'adresse du lecteur dans la configuration. Vérifiez qu'il
  répond : **Tester les lecteurs**.
- **Hors ligne** : le lecteur est débranché, injoignable ou a changé
  d'adresse. Gladys réessaie seule (5 s, 10 s, 20 s… puis toutes les deux
  minutes) ; s'il a changé d'adresse, relancez la recherche dans Découverte.
- **« ne peut pas passer au morceau suivant »** : la radio ou l'entrée en
  cours n'a pas de morceau suivant.
- Journaux : le niveau de log de l'intégration se règle avec la variable
  `LOG_LEVEL`.

## Confidentialité

L'intégration ne parle qu'à vos lecteurs, sur votre réseau local, sans
compte. Les adresses jouées (notifications, sons, flux) sont téléchargées
par le lecteur lui-même.
