const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const glob = require('glob');
const fse = require('fs-extra');

async function getLatestGitTag(prefix, projectPath) {
  const tags = execSync('git tag', { cwd: projectPath }).toString().split('\n');
  const latest = tags.filter(tag => tag.startsWith(prefix)).pop();
  return latest ? latest.slice(prefix.length) : '0';
}

function buildProject(config) {
  console.log('🛠 Старт сборки Cocos...');
  const cmd = `"${config.cocos}" --project ${config.projectPath} --build "platform=${config.platform};debug=false"`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log('✔ Cocos-сборка завершилась с кодом 0');
  } catch (err) {
    console.warn('⚠️ Cocos-сборка вернула ошибку, но продолжаем деплой.');
  }
}

function findHashedJsFile(baseName, dir) {
  const base = baseName.replace('.js', '');
  const files = glob.sync(`${dir}/**/${base}*.js`);
  return files.length ? path.basename(files[0]) : null;
}

async function patchBuild(config, version) {
  const build = config.buildPath;
  const indexFileName = findHashedJsFile(config.indexFile, build);
  const platformIndexFileName = findHashedJsFile(config.platformIndexFile, build);
  const variablesFileName = findHashedJsFile('variables.js', build);
  const gaFileName = findHashedJsFile(config.gameAnalyticsFile, build);

  if (indexFileName) {
    const indexPath = path.join(build, indexFileName);
    try { fs.unlinkSync(indexPath); } catch {}
  }

  if (platformIndexFileName) {
    const oldPath = path.join(build, platformIndexFileName);
    const newPath = path.join(build, config.indexFile);
    try { fs.renameSync(oldPath, newPath); } catch {}
  }

  if (variablesFileName) {
    const variablesPath = path.join(build, variablesFileName);
    let varsContent = fs.readFileSync(variablesPath, 'utf8');
    varsContent = varsContent
      .replace(/--debug\s*=\s*['"]?\w+['"]?/, '--debug=false')
      .replace(/--version\s*=\s*['"]?\d+(\.\d+)?['"]?/, `--version=${version}`);
    fs.writeFileSync(variablesPath, varsContent, 'utf8');
  }

  if (gaFileName) {
    try { fs.unlinkSync(path.join(build, gaFileName)); } catch {}
    const backupPath = path.join(build, config.backupDir, config.gameAnalyticsFile);
    fse.copySync(backupPath, path.join(build, config.gameAnalyticsFile));
  }
}

async function compressImages(config) {
  const imgDir = path.join(config.buildPath, 'assets');
  const caesium = path.resolve(__dirname, 'misc/caesiumclt.exe');
  const excludeList = fs.existsSync('image_compress_exclude.txt')
    ? fs.readFileSync('image_compress_exclude.txt', 'utf8')
    : '';

  const compress = (ext, level) => {
    glob.sync(`${imgDir}/**/*.${ext}`).forEach(file => {
      const md5 = execSync(`CertUtil -hashfile "${file}" MD5`).toString().split('\n')[1].trim().replace(/\s/g, '');
      if (!excludeList.includes(md5)) {
        execSync(`"${caesium}" --overwrite --quality ${level} --output "${path.dirname(file)}" "${file}"`);
      }
    });
  };

  compress('png', 30);
  compress('jpg', 60);
}

async function zipBuild(config) {
  const outputPath = config.zipOutput;
  const sourceDir  = config.buildPath;
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir);
  zip.writeZip(outputPath);
}

async function splitAndUploadZip(zipFilePath, partSizeMB, uploadUrl, game, description) {
  const partSizeBytes = partSizeMB * 1024 * 1024;
  let fileHandle = null;

  try {
    const stats = await fsp.stat(zipFilePath);
    const totalSize = stats.size;
    let start = 0;
    let partNumber = 0;

    fileHandle = await fsp.open(zipFilePath, 'r');

    const sessionID = uuidv4();
    console.log("ID сессии:", sessionID);
    while (start < totalSize) {
      const end = Math.min(start + partSizeBytes, totalSize);
      const chunkSize = end - start;
      const buffer = Buffer.alloc(chunkSize);
      await fileHandle.read(buffer, 0, chunkSize, start);
      partNumber++;
      const partFileName = `${path.basename(zipFilePath)}.part.${partNumber.toString().padStart(3, '0')}`;
      console.log(`Создается и отправляется часть ${partNumber}: ${partFileName} (${chunkSize} байт)`);

      try {
        const response = await axios.post(uploadUrl, buffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Part-Number': partNumber,
            'X-Total-Parts': Math.ceil(totalSize / partSizeBytes),
            'X-File-Name': sessionID,
            'X-Game-Name': game,
            'X-Description': description
          },
        });
        console.log(`Часть ${partNumber} успешно отправлена. Статус: ${response.status}`);
      } catch (error) {
        console.error(`Ошибка при отправке части ${partNumber}:`, error.message);
        console.log(`Повторная отправка через 10 секунд...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        console.log(`Попытка переотправить часть ${partNumber}: ${partFileName} (${chunkSize} байт)`);
        try {
          const response = await axios.post(uploadUrl, buffer, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Part-Number': partNumber,
              'X-Total-Parts': Math.ceil(totalSize / partSizeBytes),
              'X-File-Name': sessionID,
              'X-Game-Name': game,
              'X-Description': description
            },
          });
          console.log(`Часть ${partNumber} успешно отправлена. Статус: ${response.status}`);
        } catch (error) {
          console.error(`Ошибка при отправке части ${partNumber}:`, error.message);
          console.error('Не удалось повторно отправить часть ', partNumber, ", завершение операции");
          return;
        }
      }

      start = end;
    }
    console.log('Разбиение и отправка архива завершены.', sessionID);
  } catch (error) {
    console.error('Произошла ошибка:', error);
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}
async function deployBuild(config) {
  const lastVer = await getLatestGitTag(config.versionPrefix, config.projectPath);
  const version = config.versionPrefix + (parseInt(lastVer) + 1);
  console.log(`🚀 Версия билда: ${version}`);

  await buildProject(config);
  await patchBuild(config, version);
  await compressImages(config);
  await zipBuild(config);

  await splitAndUploadZip(
    config.zipOutput,
    config.upload.partSizeMB,
    config.upload.url,
    config.upload.game,
    config.upload.description
  );
}

module.exports = { deployBuild };
