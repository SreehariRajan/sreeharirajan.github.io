---
title:          "SketchCADGAN: A generative approach for completing partially drawn query sketches of engineering shapes to enhance retrieval system performance"
date:           2023
selected:       true
pub:            "3DOR’23"
pub_date:       "2023"
abstract: >-
  Retrieval systems are commonly used to find relevant data in large datasets. In engineering, these systems are useful for locating specific engineering shapes in a large dataset of engineering components. When end users want to search for a shape, they prefer a two-dimensional (2D) sketch over a three-dimensional (3D) object. However, users lacking domain knowledge may struggle to generate a complete query sketch and provide a partially completed sketch instead. Retrieving relevant information from partially drawn sketches is difficult because they may have missing edges, partially drawn circles, holes, ovals, etc. Most retrieval systems compare the similarity between the query and items in the database, so incomplete sketches may be ineffective in finding the relevant information.

To address this problem with incomplete sketches, we propose a new generative adversarial network called SketchCADGAN. This network uses a two-stage cascaded architecture, with the first network attempting to predict a CAD model image from an incomplete sketch and the second network using the CAD model image to predict a completed sketch. Both networks are trained together adversarially. Our approach is proven more effective than other advanced techniques through qualitative and quantitative comparisons. Furthermore, we present the results of the retrieval system using both partially drawn and completed sketches, and demonstrate that incorporating completed sketches from the suggested cascaded GAN architecture results in improved retrieval performance.
cover:          /assets/images/covers/sketchcadgan.jpg
authors:
- Sreehari Rajan
- Prasad Pralhad Kendre
- Kamalesh Kumar Kosalaraman
- Sanjay Santhosh Kumar Jayasree
- Akash Jayan
- Ramanathan Muthuganapathy
links:
  Paper: [https://www.cell.com](https://www.sciencedirect.com/science/article/pii/S0097849323001243)
---
