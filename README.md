# Afinador de Guitarra (PWA)

Afinador que roda no navegador do celular e pode ser instalado como app. Dois modos:

- **Microfone**: detecção de altura pelo método McLeod (MPM) sobre o áudio do microfone. Funciona apontando para a guitarra ou com o celular apoiado no corpo do instrumento (o microfone capta a vibração da madeira, útil em ambiente barulhento).
- **Vibração** (experimental): usa o acelerômetro com o celular deitado sobre o tampo. Como o sensor entrega só ~60 Hz, as frequências das cordas chegam "dobradas" (aliasing). O app sabe qual corda está sendo afinada, calcula onde o fundamental e os harmônicos cairiam depois do dobramento e procura o desvio em cents que melhor explica o sinal (filtro pente). Exige escolher a corda.

## Arquivos

| Arquivo | Função |
| --- | --- |
| `pitch.mjs` | Algoritmos (MPM, análise por aliasing). Sem dependência de navegador. |
| `app.js` | Interface, captura de microfone e acelerômetro. |
| `index.html`, `styles.css` | Tela. |
| `manifest.webmanifest`, `sw.js`, `icon.svg` | Instalação como PWA e uso offline. |
| `serve.mjs` | Servidor estático de desenvolvimento. |
| `test.mjs` | Testes com sinais sintéticos. |

## Rodar

```bash
node serve.mjs
```

Abra `http://localhost:8080` no computador.

```bash
node test.mjs
```

## Testar no celular

Microfone e acelerômetro só funcionam em **HTTPS** (ou `localhost`). Abrir pelo IP da rede local em HTTP não libera os sensores. Opções:

1. Publicar a pasta em um host estático com HTTPS (GitHub Pages, Netlify, Cloudflare Pages, Vercel).
2. Criar um túnel HTTPS para o servidor local, por exemplo com `cloudflared tunnel --url http://localhost:8080` ou `npx localtunnel --port 8080`.

No iPhone, o modo Vibração pede permissão de movimento no primeiro toque em "Iniciar".

## Limites conhecidos do modo Vibração

- **Taxa do sensor**: a linha de status mostra a taxa real e o jitter. Jitter acima de ~2,5 ms degrada muito a leitura (o navegador relê o sensor em instantes irregulares). Isso depende do aparelho.
- **Zonas cegas**: quando a corda cai perto de um múltiplo de fs/2 (por exemplo a 1ª corda, E4, a exatamente 60 Hz), nenhum harmônico sobrevive ao dobramento. O app avisa e sugere o modo Microfone.
- **Espelho**: um sinal em f e outro em k·fs − f geram amostras idênticas. Perto desses eixos a direção do desvio é ambígua; o app escolhe o candidato mais próximo da nota e informa até quantos cents a direção é confiável.
- **Identificação automática da corda** não é confiável por vibração; por isso a corda é escolhida manualmente nesse modo.

Se o acelerômetro do aparelho se mostrar inviável, o caminho é usar o modo Microfone com o celular apoiado no corpo da guitarra, que já funciona hoje.
