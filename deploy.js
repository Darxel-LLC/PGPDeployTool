const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const glob = require('glob');
const fse = require('fs-extra');
const AdmZip = require('adm-zip');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

function getLatestGitTag(prefix, projectPath) {
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
    console.warn('⚠️ Cocos-сборка вернула ошибку или предупреждения, но мы продолжаем деплой.');
  }
}

function findHashedJsFile(baseName, dir) {
  const base = baseName.replace('.js', '');
  const files = glob.sync(`${dir}/**/${base}*.js`);
  return files.length ? path.basename(files[0]) : null;
}

function patchBuild(config, version) {
  console.log('🔧 Патчинг build-папки...');
  const build = config.buildPath;

  const indexFileName = findHashedJsFile(config.indexFile, build);
  const platformIndexFileName = findHashedJsFile(config.platformIndexFile, build);
  const variablesFileName = findHashedJsFile('variables.js', build);
  const gaFileName = findHashedJsFile(config.gameAnalyticsFile, build);

  if (indexFileName) {
    const indexPath = path.join(build, indexFileName);
    try {
      fs.unlinkSync(indexPath);
      console.log(`✔ Удалён старый файл ${indexFileName}`);
    } catch (err) {
      console.warn(`⚠ Не удалось удалить ${indexFileName}: ${err.message}`);
    }
  } else {
    console.warn(`⚠ Не найден файл ${config.indexFile}*.js, пропускаем удаление.`);
  }

  if (platformIndexFileName) {
    const oldPath = path.join(build, platformIndexFileName);
    const newPath = path.join(build, config.indexFile);
    try {
      fs.renameSync(oldPath, newPath);
      console.log(`✔ Переименован ${platformIndexFileName} → ${config.indexFile}`);
    } catch (err) {
      console.warn(`⚠ Ошибка при переименовании ${platformIndexFileName}: ${err.message}`);
    }
  } else {
    console.warn(`⚠ Не найден файл ${config.platformIndexFile}*.js, пропускаем переименование.`);
  }

  if (variablesFileName) {
    const variablesPath = path.join(build, variablesFileName);
    let varsContent = fs.readFileSync(variablesPath, 'utf8');
    varsContent = varsContent.replace(/--debug/g, config.debug); // Используем config.debug
    varsContent = varsContent.replace(/--version/g, version);
    fs.writeFileSync(variablesPath, varsContent, 'utf8');
    console.log(`✔ Обновлён ${variablesFileName} версия → ${version}, debug → ${config.debug}`);
  } else {
    console.warn(`⚠ Не найден variables.js*.js, пропускаем патчинг переменных.`);
  }

  if (gaFileName) {
    const gaPath = path.join(build, gaFileName);
    try {
      fs.unlinkSync(gaPath);
      console.log(`✔ Удалён старый ${gaFileName}`);
    } catch (err) {
      console.warn(`⚠ Не удалось удалить ${gaFileName}: ${err.message}`);
    }
    const backupPath = path.join(build, config.backupDir, config.gameAnalyticsFile);
    try {
      fse.copySync(backupPath, path.join(build, config.gameAnalyticsFile));
      console.log(`✔ Восстановлен ${config.gameAnalyticsFile} из backup`);
    } catch (err) {
      console.warn(`⚠ Ошибка при копировании GameAnalytics.js: ${err.message}`);
    }
  } else {
    console.warn(`⚠ Не найден GameAnalytics.js*.js, пропускаем восстановление.`);
  }

  const indexHtmlPath = path.join(build, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    let indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
    indexHtmlContent = indexHtmlContent.replace(/index\.[a-f0-9]+\.js/g, 'index.js');
    indexHtmlContent = indexHtmlContent.replace(/GameAnalytics\.[a-f0-9]+\.js/g, 'GameAnalytics.js');
    fs.writeFileSync(indexHtmlPath, indexHtmlContent, 'utf8');
    console.log('✔ Обновлены ссылки в index.html');
  }
}

function compressImages(config) {
  console.log('🖼 Сжатие изображений...');
  const imgDir = path.join(config.buildPath, 'assets');
  const caesium = path.resolve(__dirname, 'misc/caesiumclt.exe');
  const excludeList = fs.existsSync('image_compress_exclude.txt') ? fs.readFileSync('image_compress_exclude.txt', 'utf8') : '';

  const compress = (ext, level) => {
    glob.sync(`${imgDir}/**/*.${ext}`).forEach(file => {
      const md5 = execSync(`CertUtil -hashfile "${file}" MD5`).toString().split('\n')[1].trim().replace(/\s/g, '');
      if (!excludeList.includes(md5)) {
        execSync(`"${caesium}" --overwrite --quality ${level} --output "${path.dirname(file)}" "${file}"`);
        console.log(`✔ ${file} сжат`);
      } else {
        console.log(`⏭ Пропущен ${file}`);
      }
    });
  };

  compress('png', 30);
  compress('jpg', 60);
}

function zipBuild(config) {
  console.log('📦 Создание архива через adm-zip...');
  const outputPath = config.zipOutput;
  const sourceDir = config.buildPath;

  try {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    const zip = new AdmZip();
    zip.addLocalFolder(sourceDir, '');
    zip.writeZip(outputPath);
    const { size } = fs.statSync(outputPath);
    console.log(`✔ Архив создан: ${outputPath} (${size} байт)`);
  } catch (err) {
    console.error('❌ Ошибка при создании архива adm-zip:', err);
    throw err;
  }
}

function verifyZip(filePath) {
  console.log('🔍 Проверка целостности архива...');
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    console.log(`✔ В архиве ${entries.length} объектов:`);
    entries.forEach(e => {
      console.log(`  • ${e.entryName} (${e.header.size} байт)`);
    });
  } catch (err) {
    console.error('❌ Ошибка при чтении архива:', err);
    throw err;
  }
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
  try {
    const lastVer = getLatestGitTag(config.versionPrefix, config.projectPath);
    const version = config.versionPrefix + (parseInt(lastVer) + 1);
    console.log(`🚀 Версия билда: ${version}`);

    buildProject(config);
    patchBuild(config, version);
    compressImages(config);
    zipBuild(config);
    // verifyZip(config.zipOutput); // Uncomment if verification is needed
    await splitAndUploadZip(
      config.zipOutput,
      config.upload.partSizeMB,
      config.upload.url,
      config.upload.game,
      config.upload.description
    );
  } catch (err) {
    console.error('❌ Ошибка при деплое:', err);
    throw err;
  }
}

module.exports = { splitAndUploadZip, deployBuild };